# Sammat

**Sambeställning av mat med Swish.** En liten självhostad webbapp för att samla ihop matbeställningar på jobbet, i föreningen eller på LAN:et.
Folk beställer själva utan konto, du får en färdig orderlista till restaurangen, och alla swishar rätt belopp.

📖 **Så funkar det, med bilder: https://lyzio.github.io/SamMat/**

![Beställningssidan](docs/img/round.png)

## Funktioner

- **Vem som helst startar en runda** och får en länk att dela och en slumpad 4-siffrig PIN att hantera den med. Flera rundor kan pågå samtidigt.
- **Ingen inloggning för att beställa**: namn, e-post, rätt, tillval och bortval. Varje beställning blir en lapp på beställningssidan.
- **Orderlista utan priser** att läsa upp, kopiera eller skriva ut, t.ex. `#1 (Anna) Vesuvio - Bearnaisesås - Utan lök`, plus en sammanställning per rätt.
- **Stopptid och datum**: rundan kan stänga av sig själv och mejla orderlistan till den som startade den. Den kan också bokas upp till 60 dagar i förväg.
- **Påminnelse med bekräfta/avboka**: dagen innan, samma morgon eller en egen tid.
- **Betala efter eller före**: betalningsmejl efter maten, med pris justerat efter kvittot, eller Swish direkt när man beställt.
- **Swish utan företagsavtal**: QR-kod (även inbäddad i mejlet) och `swish://`-länk med förifyllt belopp och meddelande.
- **Mejl** via valfri SMTP (t.ex. Brevo): *Maten är här*, betalningsmejl, påminnelser och orderlista.
- **Admin** (`/admin`, egen PIN): ställen, menyer, tillval/bortval och översikt över alla rundor.
- **Rensar efter sig**: när en runda avslutas raderas namn och e-post på riktigt. Gamla rundor rensas automatiskt.

## Installera

Kräver Podman eller Docker och en reverse proxy med HTTPS (t.ex. Caddy).
Imagen byggs automatiskt till `ghcr.io/lyzio/sammat` (amd64 + arm64).

```bash
mkdir -p ~/sammat && cd ~/sammat
curl -LO https://raw.githubusercontent.com/lyzio/SamMat/main/deploy/sammat-compose.yaml
curl -L -o sammat.env https://raw.githubusercontent.com/lyzio/SamMat/main/deploy/sammat.env.example
curl -LO https://raw.githubusercontent.com/lyzio/SamMat/main/deploy/sammat.caddy
chmod 600 sammat.env && nano sammat.env

sudo mkdir -p /opt/container-data/sammat/data
sudo chown -R $(id -u):$(id -g) /opt/container-data/sammat

podman-compose -f sammat-compose.yaml up -d
```

Peka din reverse proxy på `127.0.0.1:8102`. Gå sedan till `/admin`, logga in med `ADMIN_PIN` och lägg in ställen och menyer.

**Uppdatera:** `podman-compose -f sammat-compose.yaml pull && podman-compose -f sammat-compose.yaml up -d`

### Inställningar (`sammat.env`)

| Variabel | Betydelse |
|---|---|
| `ADMIN_PIN` | PIN för `/admin`. Minst 4 tecken. |
| `PUBLIC_URL` | Publik adress, används i länkar i mejl. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP (valfritt). Port 465 = TLS, annars STARTTLS. Utan SMTP skickas inga mejl. |
| `MAIL_FROM` | Avsändare, t.ex. `Sammat <sammat@example.com>`. Måste vara verifierad hos mejltjänsten. |
| `PURGE_DAYS` | Rundor raderas så många dagar efter sitt datum (standard 7). |
| `MAX_ACTIVE_ROUNDS` | Max antal rundor samtidigt (standard 30). |

En rad per `NYCKEL=värde`, utan citattecken. Värdena läses när containern skapas, så kör `up -d --force-recreate` efter ändringar.

## Utveckla

```bash
npm install
ADMIN_PIN=0042 DB_PATH=./data/sammat.db node server.js   # http://localhost:3000
```

Bygga imagen lokalt: `podman build -t sammat -f Containerfile .`

Allt ligger i `server.js` (Express + better-sqlite3 + nodemailer) och `public/` (vanlig HTML/JS, inga byggsteg).

## Säkerhet och integritet

- PIN-koderna är korta. Efter 10 fel per IP eller 20 per runda spärras inloggningen i 15 minuter. De skyddar menyerna och enskilda rundor, inget mer.
- Högst 5 nya rundor per IP och timme.
- Avslutade rundor raderas med `secure_delete` och WAL-checkpoint, så att namn och e-post inte ligger kvar i filen.
- Inga externa resurser: typsnitten (Roboto, Roboto Slab via `@fontsource`) serveras lokalt.

## Licens

[GNU General Public License v3.0](LICENSE) eller senare.

Swish är ett varumärke som tillhör Getswish AB. Sammat har ingen koppling till Swish.
