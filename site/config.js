// Filled in at go-live from Supabase → Project Settings → API.
// The public (anon) key is meant to be in the page; the database's
// security rules decide what each login can see and change.
window.BTSC_CONFIG = {
  supabaseUrl: "https://tsveuzvmiywxckyckpsc.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRzdmV1enZtaXl3eGNreWNrcHNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NjUwNDMsImV4cCI6MjEwODM0MTA0M30.zvVuXAyjh7SZSZ3ExniPimL4VwsPoTYhkZXvK_sQdJk",
  // Logins are a name + 4-digit PIN. Supabase needs an email-style
  // username behind the scenes; no mail is ever sent to it.
  loginDomain: "btsccrewhub.com"
};
