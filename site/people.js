/* People tab (office only): add logins, set PINs, put people on crews,
   plus the one-time import of the Claude Crew Hub data. */
(function(){
  const sb = () => BTSC.sb;
  let people = [], pins = {}, loading = false, editing = null;
  const crewList = () => (typeof crews !== "undefined" ? crews : []);
  const crewName2 = id => (crewList().find(c => c.id === id) || {}).name || "";
  const randPin = () => String(Math.floor(1000 + Math.random() * 9000));
  const makeUser = (name) => BTSC.norm(String(name || "").split(" ")[0]) || "";

  async function load(){
    loading = true;
    const [{ data: p }, { data: k }] = await Promise.all([
      sb().from("people").select("*").order("role").order("name"),
      sb().from("pins").select("*")
    ]);
    people = p || []; pins = {}; (k || []).forEach(x => pins[x.id] = x.pin);
    loading = false;
  }

  function loginText(list){
    const url = location.href.replace(/hub\.html.*$/, "");
    return ["BTSC Crew Hub logins", url, ""].concat(list.map(p =>
      p.name + (p.crew_id ? " (" + crewName2(p.crew_id) + " crew)" : p.role === "admin" ? " (office)" : "") + ": name " + p.username + " · PIN " + (pins[p.id] || "????"))).join("\n");
  }

  window.renderPeople = async function(){
    const box = document.getElementById("viewPeople"); if (!box) return;
    if (!BTSC.me || BTSC.me.role !== "admin") { box.textContent = "Only office admins can manage people."; return; }
    if (!people.length && !loading) { box.textContent = "Loading people…"; await load(); }
    box.textContent = "";

    // Add person
    const add = el("div", "panel");
    add.appendChild(el("h2", null, "Add a person"));
    add.appendChild(el("div", "note", "Everyone signs in with their name and a 4-digit PIN. Crew see only their own crew's jobs. Office admins see and edit everything."));
    const two = el("div", "two");
    const nm = el("input"); nm.type = "text"; nm.id = "pNew_name"; nm.placeholder = "e.g. Selvin";
    const un = el("input"); un.type = "text"; un.id = "pNew_user"; un.placeholder = "Sign-in name";
    nm.oninput = () => { if (!un.dataset.touched) un.value = makeUser(nm.value); };
    un.oninput = () => { un.dataset.touched = "1"; };
    two.append(fld("Name", nm), fld("Sign-in name", un));
    const three = el("div", "two");
    const role = el("select"); role.id = "pNew_role"; role.add(new Option("Crew member", "crew")); role.add(new Option("Office admin (edits everything)", "admin"));
    const crew = el("select"); crew.id = "pNew_crew"; crew.add(new Option("— No crew —", "")); crewList().forEach(c => crew.add(new Option(c.name + (c.members ? " (" + c.members + ")" : ""), c.id)));
    three.append(fld("Login type", role), fld("Crew", crew));
    const pin = el("input"); pin.type = "text"; pin.inputMode = "numeric"; pin.maxLength = 4; pin.id = "pNew_pin"; pin.value = randPin();
    const msg = el("div", "note");
    const go = el("button", "primary", "Add person"); go.type = "button";
    go.onclick = async () => {
      const name = nm.value.trim(), u = BTSC.norm(un.value), p = pin.value.trim();
      if (!name) { msg.textContent = "Type their name."; return; }
      if (!u) { msg.textContent = "Give them a sign-in name (letters and numbers)."; return; }
      if (!/^\d{4}$/.test(p)) { msg.textContent = "The PIN must be 4 digits."; return; }
      if (people.some(x => x.username === u)) { msg.textContent = "Someone already uses the sign-in name " + u + ". Pick another, like " + u + "2."; return; }
      go.disabled = true; msg.textContent = "Creating the login…";
      try {
        const id = await BTSC.createLogin(u, p);
        const { error } = await sb().from("people").insert({ id, name, username: u, role: role.value, crew_id: crew.value || null });
        if (error) throw { message: error.message };
        await sb().from("pins").upsert({ id, pin: p });
        toast(name + " added. Sign-in name " + u + ", PIN " + p);
        await load(); window.renderPeople();
      } catch (e) {
        msg.textContent = e.code === "taken" ? "That sign-in name already has a login. Pick another." : "Couldn't add them: " + (e.message || "try again.");
        go.disabled = false;
      }
    };
    const pr = el("div", "bbar"); pr.append(fld("PIN", pin), el("span", "spacer"), go);
    add.append(two, three, pr, msg);

    // List
    const list = el("div", "panel");
    const hb = el("div", "bbar"); hb.appendChild(el("h2", null, "Everyone (" + people.length + ")")); hb.appendChild(el("span", "spacer"));
    hb.appendChild(btn("Copy login list", "", () => {
      const txt = loginText(people.filter(p => p.active));
      try { navigator.clipboard.writeText(txt).then(() => toast("Login list copied"), () => toast("Copy didn't work here")); } catch (e) { toast("Copy didn't work here"); }
    }));
    list.appendChild(hb);
    const t = el("table", "otable ptable");
    const h = el("tr"); ["Name", "Sign-in name", "PIN", "Type", "Crew", ""].forEach(x => h.appendChild(el("th", null, x))); t.appendChild(h);
    people.forEach(p => {
      const r = el("tr", p.active ? "" : "tbd");
      r.append(el("td", null, p.name + (p.id === BTSC.me.id ? " (you)" : "")), el("td", "mono", p.username), el("td", "mono", pins[p.id] || "—"),
        el("td", null, p.role === "admin" ? "Office" : "Crew"), el("td", null, crewName2(p.crew_id) || "—"));
      const c = el("td"); c.appendChild(btn(p.active ? "Edit" : "Inactive · edit", "", () => { editing = p.id; editPerson(p); })); r.appendChild(c);
      t.appendChild(r);
    });
    const wrapT = el("div", "board"); wrapT.appendChild(t); list.appendChild(wrapT);

    // Import
    const imp = el("div", "panel");
    imp.appendChild(el("h2", null, "Move data from the Claude Crew Hub"));
    imp.appendChild(el("div", "note", "One time only. Choose the import file Claude gave you. It copies the schedule, pre-season check-offs, container bins, shop counts, change log and site maps into this site. Running it again overwrites with the file's copy."));
    const fi = el("input"); fi.type = "file"; fi.accept = ".json,application/json"; fi.id = "importFile";
    const im = el("div", "note");
    fi.onchange = async () => { const f = fi.files[0]; if (!f) return; fi.disabled = true; try { await runImport(f, im); } finally { fi.disabled = false; fi.value = ""; } };
    imp.append(fld("Import file", fi), im);

    box.append(add, list, imp);
  };

  function editPerson(p){
    const { d, close } = modal("Edit " + p.name);
    const nm = el("input"); nm.type = "text"; nm.id = "pEd_name"; nm.value = p.name;
    const role = el("select"); role.id = "pEd_role"; role.add(new Option("Crew member", "crew")); role.add(new Option("Office admin", "admin")); role.value = p.role;
    const crew = el("select"); crew.id = "pEd_crew"; crew.add(new Option("— No crew —", "")); crewList().forEach(c => crew.add(new Option(c.name, c.id))); crew.value = p.crew_id || "";
    const act = el("input"); act.type = "checkbox"; act.id = "pEd_active"; act.checked = p.active;
    const al = el("label"); al.style.cssText = "display:flex;gap:8px;align-items:center;font-weight:600"; al.append(act, document.createTextNode("Can sign in"));
    const pin = el("input"); pin.type = "text"; pin.inputMode = "numeric"; pin.maxLength = 4; pin.id = "pEd_pin"; pin.value = pins[p.id] || "";
    const two = el("div", "two"); two.append(fld("Login type", role), fld("Crew", crew));
    d.append(fld("Name", nm), el("div", "note", "Sign-in name: " + p.username), two, fld("PIN", pin), al);
    const msg = el("div", "note"); d.appendChild(msg);
    if (p.id === BTSC.me.id) { role.disabled = true; act.disabled = true; d.appendChild(el("div", "note", "You can't remove your own office access.")); }
    const acts = el("div", "acts");
    const cancel = el("button", "", "Cancel"); cancel.type = "button"; cancel.onclick = close;
    const save = el("button", "primary", "Save"); save.type = "button";
    save.onclick = async () => {
      const newPin = pin.value.trim();
      if (!/^\d{4}$/.test(newPin)) { msg.textContent = "The PIN must be 4 digits."; return; }
      save.disabled = true; msg.textContent = "Saving…";
      try {
        if (newPin !== (pins[p.id] || "")) {
          if (!pins[p.id]) throw { message: "There's no stored PIN for this login, so it can't be changed here." };
          await BTSC.changePin(p.username, pins[p.id], newPin);
          await sb().from("pins").upsert({ id: p.id, pin: newPin });
        }
        const { error } = await sb().from("people").update({ name: nm.value.trim() || p.name, role: role.value, crew_id: crew.value || null, active: act.checked }).eq("id", p.id);
        if (error) throw { message: error.message };
        close(); toast("Saved"); await load(); window.renderPeople();
      } catch (e) { msg.textContent = "Couldn't save: " + (e.message || "try again."); save.disabled = false; }
    };
    acts.append(cancel, save); d.appendChild(acts);
  }

  async function runImport(file, out){
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { out.textContent = "That file isn't a Crew Hub import file."; return; }
    const docs = Array.isArray(data.docs) ? data.docs : [];
    const imgs = Array.isArray(data.images) ? data.images : [];
    if (!docs.length) { out.textContent = "No records found in that file."; return; }
    out.textContent = "Uploading " + imgs.length + " map images…";
    for (let i = 0; i < imgs.length; i++) {
      const m = imgs[i];
      const blob = await (await fetch(m.dataUrl)).blob();
      await BTSC.assets.uploadAs(m.id, blob, blob.type || "image/jpeg");
      out.textContent = "Uploading map images… " + (i + 1) + " of " + imgs.length;
    }
    const rows = docs.map(x => ({ path: x.coll + "/" + x.id, coll: x.coll, id: x.id, data: x.data, updated_at: new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb().from("docs").upsert(rows.slice(i, i + 200));
      if (error) { out.textContent = "Stopped at record " + i + ": " + error.message; return; }
      out.textContent = "Copying records… " + Math.min(i + 200, rows.length) + " of " + rows.length;
    }
    out.textContent = "Done. Copied " + rows.length + " records and " + imgs.length + " map images. Reload the page to see everything.";
    toast("Import finished");
  }
})();
