# Changelog

## 2.8.0 – 2026-11-27
- Photo on your note: upload one (shrunk to a small JPEG in the browser, stored in `<data>/photos/`) or paste an https link. The note becomes a polaroid with an old film look, which varies between four looks. It can be changed or removed with the edit link, and is deleted with the order and the round. `PHOTOS=0` turns it off.
- Fix: the start page no longer jumps straight into the round when exactly one is open, so you can always start a new one.

## 2.7.0 – 2026-11-27
- Teams Workflows / Power Automate in tenants that do not allow "Anyone": set `FLOW_TENANT_ID`, `FLOW_CLIENT_ID` and `FLOW_CLIENT_SECRET` (an Entra app). SamMat then signs those webhook calls with a client-credentials token.
- Webhook option "Skicka med deltagarna" (teams/json): on "food is here" and "round closed" the payload gets `people` (name, email, order, language and a ready message in their language), for a private Teams message to each person. The privacy page mentions it when it is on.
- "Maten är här" works without mail configured (webhooks only).

## 2.6.4 – 2026-11-27
- Teams Workflows: clearer error on HTTP 401/403 (the trigger must allow "Anyone"), with a hint in `/admin`. README shows how to send to a person privately.

## 2.6.3 – 2026-11-26
- With `CREATE_PIN` set, `/ny` starts with a page holding only the PIN (one box per digit, paste works, submits when full). The form shows only after a correct PIN, and a remembered PIN skips the step. New endpoint `POST /api/create-pin`, with the same lockout as other PINs.

## 2.6.2 – 2026-11-26
- Footer on every page with a link to the docs site and to GitHub issues for bug reports.
- Docs: how to reach an unexposed Apprise/ntfy container over a shared network.

## 2.6.1 – 2026-11-26
- Webhook formats `ntfy` (topic URL) and `apprise` (Apprise API `/notify/<key>`). Credentials in the URL (`user:pass@` → Basic, `:token@` → Bearer) are sent as an Authorization header.
- Logo label "ADMIN" in the logo font, behind the logo. The drinks hint text is removed.

## 2.6.0 – 2026-11-26
- Drinks as their own category with quantity (+/−). They are summed at the bottom of the order list ("Dricka (hämtas själv)"), since everyone picks them up themselves.
- Add-ons and removals can be limited to certain dishes; the order form only shows what fits the chosen dish.
- Change or cancel your own order with a link shown after ordering (no mail needed), until ordering closes. The browser remembers it ("Dina beställningar här").
- Admin: paste a whole menu (`[Rätter]`, `[Dricka]`, `[Tillval]`, `[Bortval]`, `+…`, `-…`), with a preview. Contact details per place (phone, address, menu link, note), shown to whoever runs a round.
- Swedish/English: SV | EN toggle on every page (first visit follows the browser), server errors, and mails in each recipient's language. Webhooks have their own language setting.
- Optional `CREATE_PIN` to start rounds; per-IP order limit (`ORDER_LIMIT`, 20 per 10 min).
- Built-in daily backup to `<data>/backups/`, kept `BACKUP_DAYS` (7; 0 = off).
- Free-text field: "Valfri bortval eller allergier".

## 2.5.0 – 2026-11-26
- Companies (e.g. an office hotel): a round is for one company or "Alla i huset". Company picker on the start page next to the location picker, chosen when starting a round, changeable in the round settings.
- Webhooks can be limited to companies (each company's own Teams channel). Company shown in webhook text and JSON.
- It is a filter, not access control: "Alla företag" shows every round.

## 2.4.0 – 2026-11-26
- Locations (offices/cities): a place belongs to one location, or none (shown everywhere). Location picker on the start page and in "Starta en sambeställning", remembered per browser.
- Webhooks can be limited to certain locations, e.g. one Teams channel per office.
- Fixed duplicated place name in webhook text for rounds without their own name.

## 2.3.0 – 2026-11-26
- New look: "SamMat" logo in Bangers, headings in Bitter, text in Nunito Sans (all served locally via @fontsource).
- Logo as an inline image in every mail; favicon and app icon.
- Installable as an app (PWA): "Installera" button in Chrome/Edge/Android, instructions for Safari on iPhone/iPad/Mac. Shown on the start page and after ordering; can be dismissed.

## 2.2.0 – 2026-11-26
- Shared cost (e.g. delivery) split equally over everyone who ordered; payments are tracked as amounts, so a later change only asks for the difference.
- Optional automatic payment reminder (2 h / 4 h / 24 h / 48 h after the payment mail).
- "Samma som förra gången": opt-in, keyed on e-mail (HMAC, not stored in clear) + name + place; `/integritet` explains what is stored and has "Glöm mig".
- Webhooks for Teams (Workflows), Slack, Discord or plain JSON: new round, round closed, food is here.
- The free-text field is now "Valfri bortval eller allergier".
- No provider defaults in the code: SMTP and the public address come only from the env file.

## 2.1.0 – 2026-11-26
- Dated rounds (up to 60 days ahead), reminder mail (day before / same morning / custom) with optional confirm/cancel.
- Pay before (Swish right after ordering) or after (payment mail) – chosen per round.
- Rounds are purged a set number of days after their date.

## 2.0.0 – 2026-11-26
- Anyone can start a round; random PIN per round, admin PIN for places and menus.
- Several rounds at once, auto close, order list mailed to the creator.
- Note wall on the order page.

## 1.2.1 – 2026-11-25
- Plain white mails, Swish QR embedded in the payment mail.

## 1.2.0 – 2026-11-25
- Mail (food is here / payment), receipt price per order, Swish number per round, dark theme.

## 1.0.0 – 2026-11-25
- First version: one round, order list, Swish QR.
