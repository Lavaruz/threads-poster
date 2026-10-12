# GitHub Actions setup (fully automatic posting)

Files: `poster.js`, `queue.json` (365 posts, 13 Oct 2026 to 12 Oct 2027), `.gitignore`,
`.github/workflows/threads.yml` (posts), `.github/workflows/refresh-token.yml` (keeps the token alive).

1. Create a **private** GitHub repo (for example `threads-poster`). Do not add a README.
2. Upload the folder contents. Do NOT upload `.env`. From this folder:
   `git init`, `git add .`, `git commit -m "init"`, `git branch -M main`,
   `git remote add origin https://github.com/YOUR-USER/threads-poster.git`, `git push -u origin main`.
   (`.gitignore` already excludes `.env`. Check with `git status` that `.env` is not listed.)
3. Repo, Settings, Secrets and variables, Actions, New repository secret:
   - `THREADS_ACCESS_TOKEN` = the token in your `.env`
   - `THREADS_USER_ID` = the user id in your `.env`
4. (Recommended) auto token refresh: create a fine-grained personal access token
   (GitHub, Settings, Developer settings, Fine-grained tokens) for this repo only, with
   Repository permissions, **Secrets: Read and write**. Save it as repo secret `GH_PAT`.
   Without it, run `node poster.js refresh` yourself every 50 days and update the secret.
5. Repo, Actions tab, enable workflows if asked. Open **threads-poster**, Run workflow, and check the log
   says "Nothing due" (or posts what is due).
6. Open **refresh-threads-token**, Run workflow once (the token must be at least 24 hours old).
7. Done. Posts go out by themselves. `queue.json` is updated by the bot after each post.

Notes
- Posts older than 12 hours past their time are skipped (`MAX_LATE_HOURS`), so a late setup will not dump old posts.
- Edit `queue.json` on GitHub (or `git pull` first if you edit locally) to change or remove future posts.
  Set `"status": "draft"` to hold a post.
- Be around for 30 to 60 minutes after a post to answer replies. That is what the algorithm rewards.
- `node poster.js status` shows how many posts are pending and posted.
