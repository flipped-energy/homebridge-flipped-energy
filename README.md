# Flipped Energy for Homebridge

`homebridge-flipped-energy` shows your Flipped Energy tariff periods and the regional wholesale electricity price in Apple Home through Homebridge, as switches or sensors that automations can use, and gives the Eve app your meter's half-hourly energy history. It is read-only: it cannot change anything in your Flipped account, your plan or your meter, and a tap on one of its switches is refused.

## Requirements

- Homebridge 2.4.0 or later.
- Node.js 22, 24 or 26.
- An Apple home hub, for automations.
- A Flipped account with **APIs and MCPs** turned on in the Flipped portal.

## Install

In the Homebridge UI open **Plugins**, search for **Flipped Energy** and install it. Then create a token (next section), open the plugin's settings and paste it in.

## Token

1. In the Flipped portal open **APIs and MCPs**, tab **Tokens**, and create a token.
2. Scope: **Read**. The portal suggests "Read and write"; this plugin only reads.
3. Expiry: **365 days**. The portal suggests 90.
4. Paste the token (it starts with `fdk_`) into **Developer token**.

When the token expires or is revoked, the API answers 401 and the plugin stops calling it: the log holds the API's own 401 text, and the accessories show "No Response" once their values are out of date. Put a new token into the settings and restart Homebridge.

From 14 days before the token expires, the log has a warning line each time the plugin checks the account (at start-up and once a day). The optional `Token Expiring Soon` sensor detects occupancy over the same 14 days; turn on its notifications in the Home app to be told on your phone.

## Configuration

| Setting (`config.json` key) | Default | What it does |
|---|---|---|
| Name (`name`) | `Flipped Energy` | Name of the platform block in Homebridge. |
| Developer token (`token`) | required | Your token, starting with `fdk_`. |
| Account number (`accountNumber`) | empty | Needed only when your login has more than one account; the log lists the account numbers to choose from. Required in every block when you have several blocks. |
| NMI (`nmi`) | empty | Needed only when the account has more than one meter; the log lists the NMIs to choose from. |
| Wholesale Price High threshold (`priceHighThresholdCentsPerKwh`) | empty | c/kWh, wholesale, excluding GST. Empty: the market's own Elevated / Spike level. |
| Wholesale Price Low threshold (`priceLowThresholdCentsPerKwh`) | empty | c/kWh, wholesale, excluding GST, may be negative. Empty: the market's Unusually low or negative level. Must be below the high threshold when both are set. |
| Show the on/off signals as (`signalService`) | `switch` | `switch`, `occupancySensor` or `contactSensor` (see "Switches or sensors"). |
| Rates Unavailable and Wholesale Price Unavailable sensors (`availabilitySensors`) | on | Two sensors that detect when the rates or the wholesale price are unknown. |
| Token Expiring Soon sensor (`tokenExpiringSensor`) | off | A sensor that detects during the last 14 days of the token. |
| Wholesale Price as a light sensor (`wholesalePriceSensor`) | on | The wholesale price as a light sensor (1 lux = 1 c/kWh), and the `Wholesale Price Negative` signal. |
| Wholesale Price Level as an air quality sensor (`wholesalePriceLevelSensor`) | off | The market's price level as an air quality sensor. |
| Energy history for the Eve app (`eveHistory`) | on | Energy accessories with half-hourly history for the Eve app. |
| Energy as Matter electrical sensors (`matterEnergy`) | off | Experimental; see "Matter energy". Needs this block on a child bridge with Matter enabled. |

Run the plugin as a **child bridge** (`_bridge` in its block, as in the example). A restart or fault of this plugin then does not disturb your other accessories, and Matter can be enabled for it alone. Example:

```json
{
  "platforms": [
    {
      "platform": "FlippedEnergy",
      "name": "Flipped Energy",
      "token": "fdk_your_token",
      "signalService": "switch",
      "availabilitySensors": true,
      "tokenExpiringSensor": true,
      "eveHistory": true,
      "_bridge": {
        "username": "0E:F1:1B:BE:D0:02",
        "port": 51998
      }
    }
  ]
}
```

**Set `nmi` (if the log asks for it) before you build automations.** Adding or changing `nmi` or `accountNumber` later replaces every Flipped Energy accessory with a new one, and Apple Home deletes the automations that used the old ones. The same happens to a single tile when a later settings change removes it: changing `signalService`, or turning off the option that adds it.

**Several accounts:** one block per account. Every block runs on its own child bridge (its own `_bridge` with its own `username` and `port`) and sets its `accountNumber`. If a block without a child bridge comes before another block, Homebridge refuses the second one with this message: "The dynamic platform FlippedEnergy from the plugin homebridge-flipped-energy is configured multiple times in your config.json." Accessories of the first block are named `Flipped Energy ...`; those of later blocks carry the last four digits of the account number (and, when `nmi` is set, the last four characters of the NMI), for example `Flipped Energy 1234 Rates`.

When the configuration is invalid, the log lists every error and the plugin calls nothing; its accessories show "No Response".

## What appears in Apple Home

| Accessory | Tiles | Shown as | Present |
|---|---|---|---|
| `Flipped Energy Rates` | `Peak Rate`, `Off-Peak Rate` | switch or sensor (`signalService`) | always, also on a flat plan (then both off) |
| `Flipped Energy Wholesale` | `Wholesale Price High`, `Wholesale Price Low` | switch or sensor (`signalService`) | always |
| `Flipped Energy Wholesale` | `Wholesale Price Negative` | switch or sensor (`signalService`) | with `wholesalePriceSensor` |
| `Flipped Energy Wholesale` | `Wholesale Price` | light sensor reading "N lx", where N is the wholesale price in c/kWh excluding GST; a zero or negative price reads 0.0001 lx, with `Wholesale Price Negative` on when it is below zero | with `wholesalePriceSensor` |
| `Flipped Energy Wholesale` | `Wholesale Price Level` | air quality sensor in Apple's words: Excellent (unusually low), Good (normal), Inferior (elevated), Poor (spike) | with `wholesalePriceLevelSensor` |
| `Flipped Energy Status` | `Rates Unavailable`, `Wholesale Price Unavailable` | occupancy sensors, "Occupancy Detected" while that group is unknown | with `availabilitySensors` |
| `Flipped Energy Token` | `Token Expiring Soon` | occupancy sensor | with `tokenExpiringSensor` |
| `Flipped Energy Grid Import`, `Solar Export`, `Controlled Load` | one outlet tile each, always on | outlet; Apple Home shows **no kWh, no history and no cost** for it, only the Eve app does | with `eveHistory`; Grid Import once the first meter data has arrived, Solar Export and Controlled Load once the meter first reports energy for them |
| `Grid Import Energy`, `Solar Export Energy`, `Controlled Load Energy` | one Matter electrical sensor each, reading "Not Supported" | see "Matter energy" | with `matterEnergy` |

With both `eveHistory` and `matterEnergy` on, each energy channel has two tiles: the outlet and the Matter sensor.

Not shown anywhere in Apple Home: a price in dollars, your own rate, the off-peak allowance, the next rate change, the price forecast, the tariff schedule, usage cost or feed-in credit. Apple Home has no place for them.

## Switches or sensors

- **Switches** (default) are what "An Accessory is Controlled" automations use, and they can be conditions. They send no notification. They can be tapped, and a scene or Siri request that turns off "everything" includes them; the plugin refuses the change and the switch keeps its value.
- **Occupancy or contact sensors** trigger "A Sensor Detects Something" automations, can be conditions, and can send a Home notification each. They cannot be tapped and are not swept up by "turn everything off". A contact sensor shows "Open" for on.

## When a value is unknown

If the plugin cannot know a value (the API answered with an error, or the data is too old), the tile shows "No Response" the next time Home reads it. Until Home reads it again, Home can keep showing the last value. An automation on "Turns Off" does **not** run because a value became unknown.

To act on that, use `Rates Unavailable` and `Wholesale Price Unavailable`: they change when a group becomes unknown, so they can trigger an automation, be a condition and send a notification. Example: "`Wholesale Price Unavailable` detects occupancy → turn the pump off".

These two sensors also report "detected" for a few seconds at every Homebridge restart, until the first values are in; with their notifications on you get one at each restart.

## Automation examples

In the Home app: **Automation → Add**.

- **Hot water on the cheapest rate:** "An Accessory is Controlled" → `Off-Peak Rate` → Turns On → turn on the hot water relay; a second automation on Turns Off → turn it off. With sensors: "A Sensor Detects Something" → `Off-Peak Rate` → Detects Occupancy / Stops Detecting Occupancy.
- **EV charging:** the same two automations on the charger's switch or outlet.
- **Pool pump:** on when `Off-Peak Rate` turns on; off when `Peak Rate` turns on.
- **Grid-friendly:** `Wholesale Price Negative` turns on → run the pump; `Wholesale Price High` turns on → set the air conditioner to an eco scene.

On the plan Flipped sells today, `Off-Peak Rate` is on in the midday window, 11:00-14:00 (12:00-15:00 in South Australia). The window has a daily allowance: energy beyond it is charged at the balance rate while `Off-Peak Rate` is still on.

The `Wholesale ...` signals describe the regional wholesale market, not your bill, unless your plan is wholesale-linked.

## Eve app

- The Eve app shows energy history per half hour for Grid Import, and for Solar Export and Controlled Load when your meter reports them. Apple Home does not.
- Meter data reaches Flipped a day or more after the fact. The plugin reads it at start-up, at 00:01 and at 12:01 local time, so the history is always a day or more behind.
- Limit: an Eve history entry holds at most 6,553.5 W of average power, so a half hour above 3.27675 kWh (6.55 kW, for example an EV charging in the free window) has no entry in the Eve graph. It still counts in the total, and the log has a warning line with the number and kWh of such half hours.
- Totals are not corrected when the meter data is later revised (an estimated read replaced by an actual one). The Flipped app and your bill are the authority for billed figures.

## Matter energy (experimental)

Off by default. To turn it on:

1. Run the plugin on a child bridge with Matter enabled on that child bridge (`_bridge.matter` in `config.json`), and pair that child bridge's Matter node in the Home app.
2. Turn on `matterEnergy`. Without `_bridge.matter` this is a configuration error and the plugin stays idle. If Homebridge could not start Matter on the bridge, the log has an error line and the rest of the plugin runs.

```json
"_bridge": {
  "username": "0E:F1:1B:BE:D0:02",
  "port": 51998,
  "matter": { "port": 5599 }
}
```

Each energy channel then gets a Matter electrical sensor: `Grid Import Energy`, `Solar Export Energy`, `Controlled Load Energy`. A channel's Matter accessory is added at the **next Homebridge restart** after the channel first appears; the log has an info line saying so. On a new install, restart Homebridge once after the first energy data has arrived.

What Apple Home does with it (none of this is documented by Apple):

- The tile reads "Not Supported".
- The energy is added to the whole-home total of the Home app's Energy view. Whether the sensor also gets its own row there is not confirmed.
- Grid Import is the whole house: if you already have metered plugs in Home, their energy is counted twice in that total.
- The data is a day or more old, and Home may place it at the time it arrives rather than when it was used.
- Energy cannot trigger or condition an automation, and Home shows no cost, tariff or price from it.

## Troubleshooting

- **"No Response"** means the value is unknown. The Homebridge log holds the API's own error text for it.
- **Rate limit:** the API allows 60 calls a minute and 5,000 a day (UTC), shared by every token of your account, so by this plugin and any other tools you use with Flipped's API. This plugin uses at most about 1,160 a day per account block. When the limit is reached, the log holds the API's own message and the plugin waits the time the API gives before calling again.
- **The log asks for `accountNumber` or `nmi`:** it lists the values to choose from. Set one before you build automations (see "Configuration").
- **Eve shows no history after the plugin's storage was deleted or an energy accessory was removed and re-added:** Eve keeps its own copy of each accessory's history. Clear that accessory's history in the Eve app, and it downloads again from the plugin.
- Report problems at https://github.com/flipped-energy/homebridge-flipped-energy/issues with the log lines (remove your token if it appears in anything you paste).

## Privacy

- The only host the plugin calls is `mcp-api.flipped.energy`, over HTTPS, with your token, for your own account's data. There are no analytics or tracking calls.
- It stores two kinds of file in `homebridge-flipped-energy/` inside the Homebridge storage directory, readable only by the Homebridge user: `pin.json` (your account number) and one `instance-<hash>.json` per account block (kWh totals and the Eve history per channel). API responses are not stored, and successful responses are not logged.
- Your token is kept in Homebridge's `config.json`, like every plugin setting. Homebridge keeps its own cache of the accessories.
- Accessory serial numbers do not contain your account number; accessory details are visible to everyone your home is shared with.

## Trademarks and licence

Apple, Apple Home and HomeKit are trademarks of Apple Inc. This plugin is not certified by, affiliated with or endorsed by Apple, Eve Systems or the Homebridge project.

The plugin contains no HomeKit or Matter protocol code: it uses the Homebridge plugin API, and the protocol code is Homebridge, HAP-NodeJS and matter.js, installed by you. The Eve history format is documented by the community, not by Eve.

Licensed under the Apache License 2.0 (`LICENSE`). `src/eve/history.ts` is a port of the history protocol of fakegato-history, MIT License (`NOTICE`).
