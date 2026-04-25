# Calendar Integrations — Setup Checklist

Hearthboard can now pull events from Google Calendar and Outlook/Microsoft 365
Calendar twice a day (at noon and midnight, in your configured timezone). All
the code is in place. Before it works end-to-end, you need to go pick up four
OAuth credentials — two from Google, two from Microsoft — and drop them into
your `.env` file.

Everything else (token encryption key, database schema, UI, scheduler) is
already done. The account page has a "Connected calendars" card, but the
"Connect Google Calendar" / "Connect Outlook Calendar" buttons will stay
greyed out until the credentials below are filled in.

---

## 0. Redirect URIs you will need (copy these to the clipboard)

Both providers ask you for a "redirect URI" — the URL they bounce the user
back to after they grant consent. Hearthboard expects these two exact URLs:

    https://jodyrutter-sh.duckdns.org/api/integrations/google/callback
    https://jodyrutter-sh.duckdns.org/api/integrations/microsoft/callback

If you ever change your public domain, update `HEARTHBOARD_PUBLIC_DOMAIN` (or
`INTEGRATION_PUBLIC_ORIGIN`) in `.env` AND update both redirect URIs in the
Google + Microsoft dashboards to match.

---

## 1. Google Calendar

1. Go to https://console.cloud.google.com/ and sign in with the Google account
   that should own the app registration (doesn't have to be the one you sync,
   but it does need to be an account you control).
2. Create a new project. Name it whatever you want — "Hearthboard" works.
3. In the left sidebar, go to **APIs & Services → Library**. Search for
   **Google Calendar API** and click **Enable**.
4. In the sidebar, go to **APIs & Services → OAuth consent screen**.
   - User type: **External**. Click Create.
   - App name: **Hearthboard**
   - User support email: your email
   - Developer contact: your email
   - Save and Continue through the Scopes screen (don't add any scopes here —
     Hearthboard requests them at runtime).
   - On the **Test users** screen, click **+ Add users** and add every
     family member's Gmail address that will link their calendar. Without
     this, Google will block them with an "unverified app" error.
     (You can leave the app in "Testing" mode forever for a household-scale
     deployment — Google lets up to 100 test users use it.)
5. In the sidebar, go to **APIs & Services → Credentials** → **+ Create
   Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Name: **Hearthboard Web**
   - Authorized redirect URIs: paste
     `https://jodyrutter-sh.duckdns.org/api/integrations/google/callback`
   - Click Create.
6. A dialog pops up with your **Client ID** and **Client secret**. Copy both.
7. Open `/sessions/great-tender-ritchie/mnt/New project/.env` (or whatever
   path your `.env` lives at in your Hearthboard folder) and paste them in:

       GOOGLE_OAUTH_CLIENT_ID=<paste client ID>
       GOOGLE_OAUTH_CLIENT_SECRET=<paste client secret>

## 2. Outlook / Microsoft 365 Calendar

1. Go to https://portal.azure.com/ and sign in with any Microsoft account
   (personal @outlook.com works — you don't need a work tenant).
2. Search the top bar for **App registrations** and click it.
3. Click **+ New registration**.
   - Name: **Hearthboard**
   - Supported account types: **Accounts in any organizational directory
     (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft
     accounts (e.g. Skype, Xbox)**. This is the one that lets @outlook.com,
     @hotmail.com, @live.com, AND work/school accounts sign in.
   - Redirect URI: platform = **Web**, URL =
     `https://jodyrutter-sh.duckdns.org/api/integrations/microsoft/callback`
   - Click Register.
4. You land on the app's overview page. Copy the **Application (client) ID**.
5. In the left sidebar, click **Certificates & secrets** → **Client secrets**
   → **+ New client secret**.
   - Description: **Hearthboard server**
   - Expires: **24 months** (or whatever policy you're happy with —
     remember, after it expires you'll need to mint a new one and update
     `.env`)
   - Click **Add**.
   - **IMPORTANT**: copy the **Value** column immediately. Azure hides it
     forever the moment you navigate away. Do NOT copy the "Secret ID"
     column — that's not the secret itself.
6. In the left sidebar, click **API permissions**.
   - Click **+ Add a permission → Microsoft Graph → Delegated permissions**.
   - Search for and tick **Calendars.Read** and **offline_access**.
     (`User.Read` is added for you automatically — leave it.)
   - Click **Add permissions**.
   - You do NOT need to click "Grant admin consent" for personal accounts.
     For work/school accounts, either grant admin consent here or let each
     user accept the consent prompt at first sign-in.
7. Paste the two values into `.env`:

       MICROSOFT_OAUTH_CLIENT_ID=<Application (client) ID>
       MICROSOFT_OAUTH_CLIENT_SECRET=<the "Value" you copied in step 5>

## 3. Restart Hearthboard

From the Hearthboard folder:

    docker compose down
    docker compose up -d --build

On boot the server log should show a line like:

    [integrations] scheduler armed for America/Port-au-Prince (00:00 + 12:00 daily).

If instead you see:

    [integrations] scheduler idle — set INTEGRATION_TOKEN_ENCRYPTION_KEY + ...

then one of the four OAuth values (or the encryption key) is still empty.

## 4. Try it

1. Open https://jodyrutter-sh.duckdns.org/account in your browser.
2. Scroll to the **Connected calendars** card.
3. Click **Connect Google Calendar**.
   - You'll land on Google's consent screen. (If you see an
     "unverified app" warning, it's because your email isn't on the
     **Test users** list in step 1.4 above.)
4. Grant access. You should bounce back to /account and see the calendar
   listed with an initial sync count.
5. Click **Connect Outlook Calendar** and repeat.
6. Open the calendar page — imported events will have a small G or O circle
   next to the title. Clicking an imported event in the studio shows a
   banner reminding you that edits will be overwritten on the next sync.

## 5. Inviting family

Each family member who wants to sync needs to:

- Be added to the **Test users** list in the Google Cloud project (step 1.4).
  Microsoft doesn't need this — any Microsoft account can link itself.
- Sign into Hearthboard with their own account.
- Open /account → Connected calendars → Connect.

Every household member sees every imported event — that's the "whole
household" visibility you picked. Each member can disconnect their own
calendars from their own /account page; admins (you) can disconnect
anyone's.

## 6. Troubleshooting

**"Provider did not return a refresh_token" after Google sign-in**
Google only mints a refresh token on the first consent. If you connected,
then disconnected, then tried to re-connect too fast, Google may silently
skip the consent screen and not issue a new refresh token. Fix: have the
user open https://myaccount.google.com/permissions, remove Hearthboard,
and re-click Connect in Hearthboard.

**"This sign-in link has expired"**
State tokens live for 10 minutes. If the browser sat on Google's consent
page longer than that, just click Connect again.

**Microsoft: events disappear after the first sync**
Graph's `calendarView/delta` sometimes returns "@removed" for events the
user moved to a deleted calendar. We clean those up automatically; if you
see events vanishing, check the per-calendar sync error section in the
account page.

**Rate limits / quotas**
Google Calendar API is free up to 1,000,000 queries/day. Microsoft Graph
is free for personal accounts and 20/sec for work/school per app. Twice-
daily sync per household is nowhere close to either ceiling.

---

Sources: `/integrations/google.js`, `/integrations/microsoft.js`,
`/integrations/sync.js`, `/server.js` (routes prefixed `/api/integrations/`)
