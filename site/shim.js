/* BTSC Crew Hub — connects the pages to Supabase.
   Provides window.BTSC (login helpers) and window.claude.use(name), the same
   db / user / assets / downloads interface the original hub was written for,
   so the board code runs unchanged on the website. */
(function(){
  const cfg = window.BTSC_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "btsc-crew-hub-auth" }
  }) : null;

  const norm = u => String(u || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const emailFor = u => norm(u) + "@" + (cfg.loginDomain || "btsccrewhub.com");
  const pwFor = (u, pin) => "btsc-" + String(pin).trim() + "-" + norm(u);

  let me = null;            // people row for the signed-in person
  async function loadMe(){
    me = null;
    if (!sb) return null;
    const { data: s } = await sb.auth.getSession();
    const uid = s?.session?.user?.id;
    if (!uid) return null;
    const { data } = await sb.from("people").select("*").eq("id", uid).maybeSingle();
    me = data && data.active ? data : (data ? { ...data, inactive: true } : { id: uid, missing: true });
    return me;
  }
  const ready = loadMe();

  async function login(username, pin){
    if (!sb) throw { code: "not_configured", message: "The site isn't connected to its database yet." };
    const { error } = await sb.auth.signInWithPassword({ email: emailFor(username), password: pwFor(username, pin) });
    if (error) throw { code: "bad_login", message: "That name and PIN don't match. Check with the office." };
    return loadMe();
  }
  async function logout(){ if (sb) await sb.auth.signOut(); me = null; }

  // A second client that never touches the signed-in session. Used by the
  // People screen to create logins and change PINs.
  function sideClient(){
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: "btsc-side-" + Math.random() }
    });
  }
  async function createLogin(username, pin){
    const c = sideClient();
    const { data, error } = await c.auth.signUp({ email: emailFor(username), password: pwFor(username, pin) });
    if (error) throw { code: /registered|exists/i.test(error.message) ? "taken" : "signup_failed", message: error.message };
    const id = data?.user?.id;
    if (!id) throw { code: "signup_failed", message: "Supabase didn't return the new login. Check that email confirmation is turned off." };
    try { await c.auth.signOut(); } catch (e) {}
    return id;
  }
  async function changePin(username, oldPin, newPin){
    const c = sideClient();
    const { error } = await c.auth.signInWithPassword({ email: emailFor(username), password: pwFor(username, oldPin) });
    if (error) throw { code: "bad_old_pin", message: "The stored PIN didn't work, so the PIN wasn't changed." };
    const { error: e2 } = await c.auth.updateUser({ password: pwFor(username, newPin) });
    try { await c.auth.signOut(); } catch (e) {}
    if (e2) throw { code: "update_failed", message: e2.message };
  }

  /* ---------------- db: document store over public.docs ---------------- */
  const errOf = (e) => {
    const msg = (e && (e.message || e.details)) || "";
    if (/row-level security|permission denied|violates/i.test(msg) || e?.code === "42501") return { code: "invalid_argument", message: "Not allowed" };
    return { code: "unavailable", message: msg || "Network problem" };
  };
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const isObj = x => x && typeof x === "object" && !Array.isArray(x);
  function merge(base, patch){
    const out = isObj(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch || {})){
      if (isObj(v) && v.__delete__ === true) { delete out[k]; continue; }
      out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
    }
    return out;
  }
  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "").slice(0, 20);
  const snapOf = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : clone(data)), metadata: { fromCache: false, hasPendingWrites: false } });

  // One realtime channel per collection; listeners get told "something changed".
  const chans = {};
  function watchColl(coll, fn){
    if (!chans[coll]){
      const subs = new Set();
      const ch = sb.channel("docs-" + coll + "-" + rid())
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "coll=eq." + coll },
            p => subs.forEach(f => { try { f(p) } catch (e) {} }))
        .subscribe();
      chans[coll] = { ch, subs };
    }
    chans[coll].subs.add(fn);
    return () => { chans[coll] && chans[coll].subs.delete(fn); };
  }
  // Safety net: refresh live views every 30s and when the tab comes back,
  // in case a realtime message was missed (phones sleep).
  const pollers = new Set();
  setInterval(() => { if (!document.hidden) pollers.forEach(f => f()); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollers.forEach(f => f()); });

  function DocRef(path){
    const parts = path.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TypeError("Document paths need two parts, like tiles/abc: " + path);
    const [coll, id] = parts;
    const ref = {
      id, path,
      async get(){
        const { data, error } = await sb.from("docs").select("data").eq("path", path).maybeSingle();
        if (error) throw errOf(error);
        return snapOf(id, data ? data.data : null);
      },
      async set(body){
        const { error } = await sb.from("docs").upsert({ path, coll, id, data: clone(body), updated_at: new Date().toISOString() });
        if (error) throw errOf(error);
      },
      async update(patch){
        const cur = await ref.get();
        if (!cur.exists) throw { code: "invalid_argument", message: "Document does not exist" };
        const { error } = await sb.from("docs").update({ data: merge(cur.data(), patch), updated_at: new Date().toISOString() }).eq("path", path);
        if (error) throw errOf(error);
      },
      async delete(){
        const { error } = await sb.from("docs").delete().eq("path", path);
        if (error) throw errOf(error);
      },
      async acquire(){ return { acquired: true }; },
      onSnapshot(next, onErr){
        let dead = false;
        const pull = () => ref.get().then(s => { if (!dead) next(s); }).catch(e => { if (!dead && onErr && e.code !== "unavailable") onErr(e); });
        pull();
        const off = watchColl(coll, p => { const pp = (p.new && p.new.path) || (p.old && p.old.path); if (!pp || pp === path) pull(); });
        pollers.add(pull);
        return () => { dead = true; off(); pollers.delete(pull); };
      },
      collection(){ throw new TypeError("Nested collections aren't used on this site."); }
    };
    return ref;
  }
  function Query(coll, wheres, order, lim){
    const q = {
      where(f, op, v){ return Query(coll, [...wheres, [f, op, v]], order, lim); },
      orderBy(f, dir){ return Query(coll, wheres, [f, dir || "asc"], lim); },
      limit(n){ return Query(coll, wheres, order, n); },
      async get(){
        let r = sb.from("docs").select("id,data").eq("coll", coll);
        const opMap = { "==": "eq", "!=": "neq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
        for (const [f, op, v] of wheres){ if (opMap[op] && typeof v === "string") r = r.filter("data->>" + f, opMap[op], v); }
        if (order) r = r.order("data->>" + order[0], { ascending: order[1] !== "desc" }); else r = r.order("id");
        r = r.limit(Math.min(lim || 2000, 5000));
        const { data, error } = await r;
        if (error) throw errOf(error);
        let rows = (data || []).map(x => ({ id: x.id, data: x.data }));
        const test = (val, op, v) => op === "==" ? val === v : op === "!=" ? val !== v : op === "<" ? val < v : op === "<=" ? val <= v : op === ">" ? val > v : op === ">=" ? val >= v
          : op === "in" ? (v || []).includes(val) : op === "not-in" ? !(v || []).includes(val) : op === "array-contains" ? Array.isArray(val) && val.includes(v) : true;
        rows = rows.filter(x => wheres.every(([f, op, v]) => test(x.data?.[f], op, v)));
        if (order){ const [f, d] = order; rows.sort((a, b) => { const A = a.data?.[f], B = b.data?.[f]; if (A === B) return 0; if (A == null) return 1; if (B == null) return -1; return (A < B ? -1 : 1) * (d === "desc" ? -1 : 1); }); }
        if (lim) rows = rows.slice(0, lim);
        const docs = rows.map(x => snapOf(x.id, x.data));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } };
      },
      onSnapshot(next, onErr){
        let dead = false, t = null;
        const pull = () => q.get().then(s => { if (!dead) next(s); }).catch(e => { if (!dead && onErr && e.code !== "unavailable") onErr(e); });
        pull();
        const off = watchColl(coll, () => { clearTimeout(t); t = setTimeout(pull, 250); });
        pollers.add(pull);
        return () => { dead = true; off(); pollers.delete(pull); };
      }
    };
    return q;
  }
  function CollRef(coll){
    if (!coll || coll.includes("/")) throw new TypeError("Collection names are one word, like tiles: " + coll);
    const base = Query(coll, [], null, null);
    return Object.assign({}, base, {
      path: coll,
      doc(id){ return DocRef(coll + "/" + (id || rid())); },
      async add(body){ const r = DocRef(coll + "/" + rid()); await r.set(body); return r; }
    });
  }
  const db = { doc: p => DocRef(p), collection: c => CollRef(c) };

  /* ---------------- user ---------------- */
  const profileCache = {};
  const user = {
    isOwner: () => !!(me && me.role === "admin" && !me.inactive),
    canEdit: async () => !!(me && me.role === "admin" && !me.inactive),
    can: async (what) => !!(me && me.role === "admin" && !me.inactive),
    id: async () => (me ? me.id : null),
    me: async () => ({ id: me?.id || null, name: me?.name || "", guest: false }),
    async profiles(ids){
      const want = (ids || []).filter(x => x && !profileCache[x]);
      if (want.length){
        const { data } = await sb.from("people").select("id,name").in("id", want);
        (data || []).forEach(p => profileCache[p.id] = { id: p.id, name: p.name, guest: false });
        want.forEach(x => { if (!profileCache[x]) profileCache[x] = { id: x, name: "", guest: false }; });
      }
      const out = {}; (ids || []).forEach(x => out[x] = profileCache[x] || { id: x, name: "" }); return out;
    },
    async search(){ return []; }
  };

  /* ---------------- assets: map images in the private "maps" bucket ---------------- */
  const urlCache = {};
  async function blobUrl(id){
    if (!id) return null;
    const hit = urlCache[id];
    if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await sb.storage.from("maps").createSignedUrl(id, 60 * 60 * 6);
    if (error || !data) throw { code: "not_found", message: "Map image not found" };
    urlCache[id] = { url: data.signedUrl, exp: Date.now() + 5.5 * 3600 * 1000 };
    return data.signedUrl;
  }
  const assets = {
    async upload(blob, opts){
      const type = (opts && opts.type) || blob.type || "image/jpeg";
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      const id = rid() + "." + ext;
      const { error } = await sb.storage.from("maps").upload(id, blob, { contentType: type, upsert: false });
      if (error) throw { code: /row-level|not authorized|unauthorized/i.test(error.message) ? "not_granted" : /size|large/i.test(error.message) ? "too_large" : "upstream_error", message: error.message };
      return { id, url: await blobUrl(id), sizeBytes: blob.size, contentType: type };
    },
    async uploadAs(id, blob, type){
      const { error } = await sb.storage.from("maps").upload(id, blob, { contentType: type || blob.type || "image/jpeg", upsert: true });
      if (error) throw { code: "upstream_error", message: error.message };
      return id;
    },
    async list(){ return { assets: [], usage: {} }; },
    async delete(id){ const { error } = await sb.storage.from("maps").remove([id]); if (error) throw { code: "upstream_error", message: error.message }; return { deleted: true }; }
  };

  /* ---------------- downloads: a normal browser download ---------------- */
  const downloads = {
    async save({ filename, data }){
      const blob = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = u; a.download = filename || "download"; document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(u); }, 4000);
      return { status: "saved" };
    }
  };

  window.BTSC = { sb, configured, ready, get me(){ return me; }, loadMe, login, logout, createLogin, changePin, norm, blobUrl, db, assets };
  window.claude = {
    async use(name){
      await ready;
      if (!sb || !me || me.missing || me.inactive) return name === "downloads" ? downloads : null;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "downloads") return downloads;
      if (name === "assets") return me.role === "admin" ? assets : null;
      return null;
    }
  };
})();
