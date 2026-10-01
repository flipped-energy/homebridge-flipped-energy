# Changelog

## 0.1

First release line; releases are numbered `0.1.<patch>`.

- `Peak Rate` and `Off-Peak Rate` from your Flipped tariff.
- `Wholesale Price High`, `Wholesale Price Low` and `Wholesale Price Negative` from the regional wholesale price, with optional thresholds in c/kWh.
- `Wholesale Price` as a light sensor (1 lux = 1 c/kWh) and, opt-in, `Wholesale Price Level` as an air quality sensor.
- The on/off signals as switches, occupancy sensors or contact sensors.
- `Rates Unavailable` and `Wholesale Price Unavailable` sensors; opt-in `Token Expiring Soon` sensor and a log warning 14 days before the token expires.
- An unknown value is shown as "No Response", never as off, a default or the last value; Homebridge restarts start from "No Response".
- Half-hourly energy history in the Eve app for grid import, solar export and controlled load.
- Experimental Matter electrical energy sensors, on a child bridge with Matter enabled.
- Several accounts: one block per account, each on its own child bridge.
