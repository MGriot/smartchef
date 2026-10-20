# Privacy

SmartChef has no accounts with us, no analytics and no telemetry. Your library lives on your device (or on a server you run yourself). Nothing is sent to the author.

## What leaves your device, and only when you use the feature

| Feature | Sent to | What |
|---|---|---|
| AI import, recipe check, translation (Anthropic, Google Gemini, OpenAI) | The provider you chose and entered a key for | Recipe text, photos or media you submit, and the names of the ingredients, tools and techniques in your library (used for matching). Subject to that provider's own terms. |
| AI with Ollama | Your own Ollama host | Recipe content only; your library's ingredient names are not sent. |
| Recipe origin map | OpenStreetMap tile servers, Nominatim | Map tile requests and place names for geocoding; your IP address is visible to them. |
| Git Remote sync | The git host you configure | Your library as files, including any API-free settings you sync. |
| Photo/PDF text recognition | One-time download of the Tesseract language model (~12 MB) | Nothing about you. Recognition runs on the device. |
| Discover | The recipe sites it lists | A normal page request. |

## API keys
Keys for cloud AI providers stay on the device (standalone mode) or are stored encrypted on your own server (server mode). They are excluded from backups and sync.

## Your data
Export or delete everything at any time through backup/restore and by removing the app's data. Because there is no central service, the author cannot access, recover or delete it for you.

## Server mode
If you run the server, you are the data controller for the accounts and recipes on it. Choose real values for `SESSION_SECRET` and `LLM_KEY_ENCRYPTION_SECRET`, and put the API behind HTTPS when it is reachable from the internet.
