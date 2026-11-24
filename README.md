# Fresh Home

Free and open source. If it helps you: ☕ [ko-fi.com/vanshmusic](https://ko-fi.com/vanshmusic) · 👍 the [Ratings issue](https://github.com/VanshBhardwaj24/orpheon-fresh-home/issues/1)

An [Orpheon](https://github.com/kota-zo/orpheon) extension that fills Home again. It adds two
sections at the end of Home:

**Fresh for you**
- **New from your artists**: albums, EPs and singles from the artists you play (and the ones you
  follow), released in the last 30 days, newest first.
- **Newest songs**: the songs of those releases, in one list.
- **Because you played X**: a radio of the last artist you played (it changes at most every 20 minutes).

**Popular in your country**
- **Top songs** and **Top albums**: Apple Music's most played in your country.
- **Moods and genres**: playlists for the words you pick (Chill, Workout, Focus, Party by default).

It refreshes by itself every 6 hours when the phone is online (moods once a day), or when you tap
**Refresh**. Home never waits for the network: it shows what was kept from the last refresh.

## Settings

| Setting | What it does |
|---|---|
| Country | Whose charts and store to use. Auto follows the app's language, else the United States. |
| Artists to follow | Comma-separated. Their new releases show before you play them. |
| Moods and genres | Comma-separated, up to 6. Each becomes a shelf of playlists. |
| New means released in the last | 14, 30, 60 or 90 days. |
| Four toggles | Show or hide each shelf. |
| Refresh now / Forget my artists | Ask again now / clear the play counts kept on this phone. |

## What is sent where

| To | What | Why |
|---|---|---|
| `itunes.apple.com` | Artist names, then their iTunes ids, and your country code | New releases |
| `rss.marketingtools.apple.com` | Your country code | Top songs and albums |
| `api.deezer.com` | The last artist's name, your mood words | Radio and playlists |

Nothing else leaves the phone. Play counts (artist name, a count, the last time) stay in the
extension's own storage on the phone, at most 300 artists, and **Forget my artists** clears them.
No account, no key, no tracking. Cover images load from `*.mzstatic.com` and `*.dzcdn.net`.

## Good to know

- The songs and albums are opened by their iTunes or Deezer ids. If your Orpheon country is
  different from this extension's country, a few iTunes items may not open: set the same country.
- From some countries (India, for one) Deezer does not answer its charts or artist pages, which is
  why releases and charts come from Apple and only the radio and playlists come from Deezer.
- An artist is matched by exact name. A name the catalogues spell differently is skipped.

## Testing

With Orpheon's desktop runner (`myspoti-ext`, see the
[API documentation](https://github.com/kota-zo/orpheon/blob/main/docs/extensions/API.md)):

```
myspoti-ext check .
myspoti-ext test . --scenario tests/fixtures.json   # canned answers, no network
myspoti-ext test . --scenario tests/offline.json    # every request fails: Home still answers
myspoti-ext test . --scenario tests/failures.json   # quota errors, bad image hosts, a slow network, Forget
myspoti-ext test . --scenario tests/live.json       # the real catalogues
```

## License

MIT, see `LICENSE`.

## Support

Fresh Home is free and nothing is locked. Donations pay for time on new versions and translations: [ko-fi.com/vanshmusic](https://ko-fi.com/vanshmusic). A 👍 on the [Ratings issue](https://github.com/VanshBhardwaj24/orpheon-fresh-home/issues/1) helps just as much. In the app there is one line in the settings page and, after a month of use, one line on Home that you can hide. No pop-ups, no tracking.
