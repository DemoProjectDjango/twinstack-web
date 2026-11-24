# Working together on this repo

More than one person (and Claude) works here at the same time, and every merge
to `master` deploys to the live server. These rules keep us from breaking each
other's work or the live site.

1. **Never commit to `master`.** GitHub refuses direct pushes to it.
   Start every task on its own branch from the latest `master`:

   ```bash
   git checkout master && git pull
   git checkout -b <your-name>/<short-task>   # e.g. saiful/stripe-refunds
   ```

2. **Open a pull request into `master`.** The "check" job (client lint and
   build) runs on it and must pass before GitHub allows the merge. Merging is
   what deploys, so merge only finished work.
3. **Keep your branch current.** At least daily, and always before merging:
   `git pull --rebase origin master`. GitHub requires the branch to be up to
   date with `master` before it merges.
4. **Keep branches small and short-lived** (a day or two), and say in the team
   chat which area you're working on, so two people don't change the same files.
5. **Edit `CLAUDE.md` in its own small commit,** never mixed into a feature
   change. It's the file most likely to conflict.
6. **Line endings are handled by `.gitattributes`** (LF for everyone). Don't
   change it, and don't commit a file whose diff shows every line changed.
