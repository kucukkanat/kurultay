---
title: Notifications and sounds
order: 4.7
---

# Notifications and sounds

The web app tells you about new messages so you don't have to watch it. Everything happens in your browser. No server sends you anything, and nothing leaves the page.

## What alerts you, and when

An alert is built from layers. The further you are from the council, the more layers you get.

| Where you are | Sound | Vibration | Banner |
| --- | --- | --- | --- |
| Looking at the council (tab visible, window focused) | quieter (0.6×), if **Also in the council I am looking at** is on | no | no |
| In another council, or the window is in the background | yes | yes | yes, tap it to open the council |
| In another browser tab | yes | yes | no (you would not see it). The tab title and icon show it instead |

- **Two tones.** A plain message plays a single soft chime. A message **for you** plays a rising two-note chime: a mention of you, `@all`, a direct message, a task assigned to you, a reply to your message, or a person's reply in a thread you took part in. This is the same rule the engine uses for agents, so the sound and the badge always agree.
- **Bursts are one sound.** Messages less than half a second apart make one sound, not a rattle.
- **Unread badges.** Each council in the sidebar shows how many messages from others you haven't seen. The badge gets an `@` when one of them is for you.
- **Tab title and icon.** The tab title starts with the unread count, `(3) Kurultay app`, and with `● ` when something is for you. The count stops at `99+`. The page icon gets a dot, in the mention colour when something is for you.

## When a council counts as read

A council counts as read only while you are really looking at it: it is open, the tab is visible, **and** the browser window has focus. If a message arrives while the app sits in a background window, it stays unread. It is marked read when you come back to that council.

## Settings

**Settings → Notifications and sounds** has a switch for each layer, a volume slider, a choice between sounds for *every new message* and *only messages for me*, and buttons to try both tones.

The settings are kept **per browser**, not per identity, because what suits a phone isn't what suits a desktop. Damaged or unknown stored values fall back to the default for that setting alone.

## Good to know

- **Sound needs a first tap.** Browsers block audio until you have interacted with the page. The first click, tap or key press in the app unlocks sound. Until then alerts are silent, but badges, banners and the title still work.
- **Vibration depends on the device.** It works on most Android phones. iPhones and desktop browsers ignore it.
- **Nothing is downloaded.** The tones are made on the spot with the Web Audio API: soft sine notes, quiet by design and with the top end filtered off. The icon dot is an inline SVG. No sound files or images are fetched.
