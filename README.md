# Threads Poster

Publishes text posts to your Threads account through Meta's official Threads API. No dependencies, no paid services. It reads a queue (`queue.json`), posts whatever is due, and marks each item as posted.

| File | What it is |
|---|---|
| `poster.js` | The script |
| `queue.json` | Your posts and when they go out |
| `README.md` | This walkthrough |

## 0. Requirements

- Node.js **20.12 or newer** (check with `node -v`)
- A Threads account and a free Meta developer account

Put the three files in one folder. You'll create a `.env` file in the same folder in step 2. If you use git, add `.env` to `.gitignore`.

## 1. Create the Meta app (about 10 minutes)

1. Go to [developers.facebook.com](https://developers.facebook.com), log in and create an app. When it asks for a use case, pick the **Threads API** one.
2. In the use case settings, enable the permissions **`threads_basic`** and **`threads_content_publish`**.
3. Add yourself as a tester: **App Dashboard → App roles → Roles → Add People → Threads Tester**, then enter your Threads username.
4. Accept the invite on Threads (app or website): **Settings → Account → Website permissions**.
5. Generate an access token for your own account. I believe the app dashboard has a "User Token Generator" in the Threads API settings, but I couldn't verify that screen, and Meta changes it often. If you can't find it, follow Meta's "Getting Access Tokens" guide in the Threads API docs. The token you get is **short-lived (1 hour)**, so do step 2 right away.

Your app has two app IDs and two secrets. Always use the **Threads** app ID and secret.

Because you hold a role on your own app, you can post to your own account without going through App Review.

## 2. Set up `.env`

Create `.env` next to `poster.js`:

```
THREADS_ACCESS_TOKEN=paste-the-short-lived-token-here
THREADS_APP_SECRET=paste-the-Threads-app-secret-here
```

The secret is in **App settings → Basic → Threads App secret**. Then run:

```
node poster.js exchange
node poster.js whoami
```

- `exchange` swaps the 1-hour token for a **60-day** token and saves it to `.env`.
- `whoami` confirms the login and saves `THREADS_USER_ID` to `.env`.

After this you can delete `THREADS_APP_SECRET` from `.env`. Only `exchange` uses it.

## 3. Make your first post

```
node poster.js post "Testing my new poster" --dry-run
node poster.js post "Testing my new poster"
```

The first command only checks the text. **The second one is live and public.** Delete the post in the Threads app afterwards if you don't want to keep it.

Optional flags: `--topic Gaming` adds a topic tag (no periods or `&`), and `--link https://...` attaches a link preview card.

## 4. Use the queue

`queue.json` is a JSON array. Each item looks like this:

```json
{
  "text": "The post text (max 500 characters)",
  "publishAt": "2026-10-13T09:00:00+07:00",
  "topic": "optional topic tag",
  "link": "https://optional-link-preview.com",
  "status": "pending"
}
```

| Field | Notes |
|---|---|
| `text` | Required. Emoji count as their UTF-8 byte length, so a post full of emoji hits the limit sooner. |
| `publishAt` | Optional. Include the timezone offset (`+07:00` for Jakarta). Left out means "post on the next run". |
| `status` | `pending` (or missing) goes out when due. `draft` is ignored. The script sets `posted` or `failed` itself. |

The examples in the file are all `draft`, so nothing goes out until you change them to `pending`. Then:

```
node poster.js run --dry-run   # shows what would be posted
node poster.js run             # posts everything that is due
```

Safety rails: at most 5 posts per run (`MAX_PER_RUN`), a 10 second gap between posts (`GAP_SECONDS`), and an item is retried up to 3 times before it is marked `failed`. Posted items get their Threads ID and link saved in the queue.

## 5. Schedule it

`run` posts what is due and exits, so you just need something to call it regularly.

**Option A: your own computer or a VPS.** Easiest, and token refresh keeps working because `.env` persists.

```
# crontab -e   (every hour)
0 * * * * cd /path/to/threads-poster && node poster.js run >> poster.log 2>&1
```

On Windows, use Task Scheduler to run `node poster.js run` in that folder every hour.

**Option B: GitHub Actions.** Runs while your computer is off. Use a **private** repo, since the queue holds unposted content. Add `THREADS_ACCESS_TOKEN` and `THREADS_USER_ID` as repository secrets, then create `.github/workflows/threads.yml`:

```yaml
name: threads-poster
on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node poster.js run
        env:
          THREADS_ACCESS_TOKEN: ${{ secrets.THREADS_ACCESS_TOKEN }}
          THREADS_USER_ID: ${{ secrets.THREADS_USER_ID }}
      - run: |
          git config user.name "threads-poster"
          git config user.email "actions@users.noreply.github.com"
          git add queue.json
          git diff --staged --quiet || (git commit -m "update queue" && git push)
```

The last step commits the updated queue back so posts are not sent twice. Scheduled runs can start a few minutes late, so treat `publishAt` as "around this time".

## 6. Keep the token alive

The long-lived token lasts 60 days. Refresh it about every 50 days:

```
node poster.js refresh
```

It must be at least 24 hours old and not yet expired. Each refresh gives you another 60 days. On GitHub Actions the refreshed token is not saved automatically, so run `node poster.js refresh --show`, then update the repo secret with the new value (for example `gh secret set THREADS_ACCESS_TOKEN`). Put a calendar reminder in. If the token does expire, repeat steps 1 and 2.

## Limits to know

- **250 posts per 24 hours** per profile. Check usage with `node poster.js limit`.
- **500 characters** per post, and at most **5 links** per post.
- Posting in huge bursts can look like spam to the platform, even when the API allows it. A handful of posts a day is safer.

## Fill the queue with Claude

Ask something like: *"Write 14 Threads posts for next week as JSON in the queue.json format, at 09:00 and 19:00 WIB, status draft."* Paste the result into `queue.json`, skim it, and flip the ones you like to `pending`. Keeping `draft` as the default means nothing goes live under your name without you seeing it first.

## Troubleshooting

- **"Access token rejected (code 190)"**: the token expired or is wrong. Run `refresh`, or generate a new token and run `exchange` again.
- **A permissions error**: check that both permissions are enabled in the app and that you generated the token *after* enabling them.
- **An error about the user not being allowed or not a tester**: the tester invite hasn't been accepted yet (step 1.4).
- **Nothing posts**: run `node poster.js run --dry-run`. Items need `status` of `pending` (or none) and a `publishAt` in the past.
- **"Post is N characters"**: shorten it. The script checks length before sending anything.
