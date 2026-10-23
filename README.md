# BTSC Crew Hub

Baltimore crew schedule, pre-season site prep, container bins and site maps, with a
name + 4-digit PIN login for everyone.

- **Crew** (`index.html`): sign in, see *My day* for their crew, tap **Mark done**, add a
  note, open the site map.
- **Office** (`hub.html`): the full board — Schedule, Pre-season (with site maps),
  Containers, and People (add logins, set PINs, put people on crews).

## How it's built

| Part | What it is |
| --- | --- |
| `site/` | Plain HTML/JS, no build step. Published by `.github/workflows/pages.yml`. |
| `site/config.js` | Supabase project URL and public key (filled in at go-live). |
| `site/shim.js` | Connects the pages to Supabase: data, live updates, logins, map images. |
| `supabase/setup.sql` | Tables, security rules, the crew **Done** function and the map storage bucket. |

No schedule data, PINs, phone numbers or lock codes live in this repo. They are in the
Supabase database, behind the login.

## Go-live checklist

1. **Supabase** — create a free account and a project (any name, region *East US*).
2. **Run the setup** — Supabase → SQL Editor → New query → paste `supabase/setup.sql` → Run.
3. **Turn off email confirmation** — Authentication → Sign In / Providers → Email →
   switch off *Confirm email* → Save. (Logins are name + PIN; no mail is ever sent.)
4. **Connect the site** — Project Settings → API: copy the *Project URL* and the
   *anon public* key into `site/config.js`.
5. **Publish** — Settings → Pages → Source: *GitHub Actions*.
6. **First login** — open the site, fill in *Set up the hub* with your name and a PIN.
   That login becomes the first office admin.
7. **Move the data** — Hub → People → *Move data from the Claude Crew Hub* → choose the
   import file Claude gave you.
8. **Add everyone** — People → *Add a person* for each crew member and office admin,
   then *Copy login list* and hand out the PINs.

## Notes

- A free Supabase project pauses after a week with no use; daily schedule use keeps it awake.
- PINs are 4 digits by design. Supabase limits repeated sign-in attempts.
- To change something, ask Claude in the BTSC Crew Hub conversation; it works in this repo.
