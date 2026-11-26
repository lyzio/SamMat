# Changelog

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
