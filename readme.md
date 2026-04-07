# 🚀 RL Mafia Bot

A Discord bot for playing Mafia with your Rocket League friends. Players are secretly assigned roles, vote to eliminate the mafia, and results are tracked on a live web dashboard.

---

## Files

| File | Purpose |
|------|---------|
| `bot.js` | Main bot — Discord logic, game engine, web server |
| `dashboard.html` | Live web dashboard |
| `favicon.svg` | Dashboard favicon |
| `package.json` | Node dependencies |
| `.env` | Environment variables (not committed) |
| `data.json` | Persistent game data — auto-generated on first round |

---

## Commands

| Command | Description |
|---------|-------------|
| `/startgame` | Pick mafia from players in your voice channel |
| `/newround` | Re-roll a new mafia from the same player pool |
| `/vote` | Start a private DM vote — everyone gets buttons |
| `/endvote` | Force-close the vote early |
| `/endgame` | Reset all game state (preserves scores/history) |
| `/pause` | Pause the vote timer |
| `/resume` | Resume a paused vote |
| `/kick @player` | Remove a player mid-game |
| `/status` | Show live game status (ephemeral) |
| `/standings` | Post current standings in chat |
| `/history` | Show recent round history (ephemeral) |
| `/score` | Show scoreboard |
| `/optout [@player]` | Opt yourself or someone out of the next game |
| `/optin [@player]` | Opt back in |
| `/dashboard` | Get the dashboard link (ephemeral) |
| `/testgame` | Solo test game — bot owner only |

---

## Game Settings (via dashboard admin panel)

Log in with Discord on the dashboard to access the admin panel.

| Setting | Default | Description |
|---------|---------|-------------|
| Vote Timer | 60s | How long the vote lasts before auto-resolving |
| Reminder | 30s | When to DM non-voters a nudge |
| Min Players | 2 | Minimum players to start |
| Mafia Count | 1 | How many mafia per round (capped at half player count) |
| Double Agent % | 0 | Chance of an extra surprise mafia (legacy) |

---

## How a round works

1. Everyone joins a voice channel
2. Someone runs `/startgame` — bot picks mafia and DMs everyone their role
3. Play a Rocket League game
4. Someone runs `/vote` — everyone gets private DM buttons to vote
5. Bot auto-reveals when everyone votes (or after the timer)
6. Ties go to sudden death; if still tied, random pick
7. Run `/newround` to go again with the same group

---

## Dashboard

The web dashboard shows:
- **Live game** — who's in, vote progress, countdown timer
- **Win/loss chart** — last 20 rounds at a glance, streak banner
- **Scoreboard** — win rate, times as mafia, catch rate (click a player for full stats)
- **Round history** — outcome, mafia, vote breakdown, duration
- **Admin panel** (login required) — settings, kick player, export CSV, reset scores

### Discord login
The dashboard uses Discord OAuth2. Your Discord account (`251503326447927306`) gets admin access automatically. Other visitors can log in but only see the dashboard.

---

## Data persistence

Game history, scores, and settings are saved to `data.json` after every round. Active game state (player list, roles) is also saved so a bot restart mid-session doesn't wipe the current game — though the vote timer won't survive a restart and will need `/vote` to be re-run.

---

## Notes

- The mafia is never revealed on the dashboard during an active round
- Test rounds (`/testgame`) don't count toward scores or history
- `/endgame` is your escape hatch if a round gets stuck — it clears state without affecting past scores