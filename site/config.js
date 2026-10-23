// Filled in at go-live from Supabase → Project Settings → API.
// The public (anon) key is meant to be in the page; the database's
// security rules decide what each login can see and change.
window.BTSC_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  // Logins are a name + 4-digit PIN. Supabase needs an email-style
  // username behind the scenes; no mail is ever sent to it.
  loginDomain: "btsccrewhub.com"
};
