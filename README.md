# M-A Building Field Orders

A phone-friendly web app for field crews to order materials and equipment for jobsites.
It's hosted free on **GitHub Pages**, with data, logins and notifications handled by **Supabase**.

**Field employees** sign in, pick a jobsite, add items from the catalog (or type custom ones), set quantity, needed-by date, priority and delivery notes, and submit. They can track status, cancel pending orders, and reorder past ones.

**Admins** get a dashboard of all orders that updates live. They can set status (Pending → Approved → Ordered → Delivered / Rejected), add office notes like a PO number or ETA, print an order, export to CSV, and manage the catalog, jobsites and users.

**Push notifications:** admins get one when a new order comes in, and field users get one when the status of their order changes.

---

## Setup (about 20 minutes)

### 1. Create the database
1. Go to [supabase.com](https://supabase.com) and open your project, or create a new one.
2. In the left menu, open **SQL Editor** → **New query**.
3. Open `supabase/schema.sql` from this folder, copy everything, paste it in, and click **Run**.
   It creates all tables and security rules, plus a sample jobsite and catalog items.

### 2. Connect the app to Supabase
1. In Supabase, open **Project Settings** → **API** (or **API Keys**).
2. Copy the **Project URL** and the **anon / publishable** key.
3. Open `config.js` and paste them into `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

> The anon key is meant to be public, and your data is protected by the security rules from step 1.
> **Never** put the `service_role` or secret key in `config.js`.

### 3. Logins
1. In Supabase, go to **Authentication** → **Sign In / Providers** and turn **off** "Allow new users to sign up". Only people you add can log in.
2. Go to **Authentication** → **Users** → **Add user** → **Create new user**. Enter an email and starting password and check **Auto Confirm User**. Do this for yourself first.
3. Make yourself an admin. In the **SQL Editor**, run this with your email:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'jthomas@mabldg.com');
   ```
   After that you can change anyone's role from the app under **Admin → Users**.
4. To add field employees later, repeat step 2 for each one, then set their name in **Admin → Users**.

### 4. Publish on GitHub Pages
1. On GitHub, click **New repository**. Name it something like `field-orders` and make it **Public**.
   (On a free plan, Pages only works on public repos. That's fine because the code has no secrets.)
2. Click **uploading an existing file** and drag in **everything in this folder**: `index.html`, `app.js`, `styles.css`, `config.js`, `sw.js`, `manifest.webmanifest`, the `icons` folder and the `supabase` folder. Then click **Commit changes**.
3. Go to **Settings** → **Pages**. Under "Build and deployment", choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
4. After a minute or two your app is live at
   `https://YOUR-GITHUB-USERNAME.github.io/field-orders/`
5. Back in Supabase, open **Authentication** → **URL Configuration**. Set **Site URL** to that address and add it under **Redirect URLs** too. This makes "Forgot password" emails link back to the app.

### 5. Push notifications
The public key is already in `config.js`. The private key is in the separate file `push-keys-PRIVATE.txt`. **Don't upload that file to GitHub.**

1. In Supabase, open **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly **`notify`**. Replace the sample code with everything in `supabase/functions/notify/index.ts`, then click **Deploy**.
   (Leave "Verify JWT" **on**.)
3. Open **Edge Functions** → **Secrets** and add these three:
   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | from `push-keys-PRIVATE.txt` |
   | `VAPID_PRIVATE_KEY` | from `push-keys-PRIVATE.txt` |
   | `VAPID_SUBJECT` | `mailto:jthomas@mabldg.com` |
4. In the app, go to **Account** → **Turn on notifications** → **Send test**.

> **iPhone users:** notifications need iOS 16.4 or newer, and the app must first be added to the Home Screen (Safari → Share → **Add to Home Screen**). Open it from that icon, then turn on notifications.
> **Android:** Chrome works directly in the browser, and installing the app is recommended.

### 6. Roll out to the crew
Send everyone the link and their login. Ask them to add it to their Home Screen so it opens like an app.

---

## Making changes later
- **Catalog, jobsites and users** are managed in the app under **Admin**, so you don't need to touch code.
- **Name or colors:** edit `COMPANY_NAME` / `APP_NAME` in `config.js`, or the colors at the top of `styles.css`.
- **Code changes:** edit the files on GitHub with the pencil icon and commit. Pages republishes automatically.
  If phones keep showing an old version, change `field-orders-v1` to `-v2` in `sw.js`.

## Files
| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The app |
| `config.js` | Your Supabase connection settings |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app + notifications |
| `supabase/schema.sql` | Database tables and security rules (run once) |
| `supabase/functions/notify/index.ts` | Push notification sender (Supabase Edge Function) |
