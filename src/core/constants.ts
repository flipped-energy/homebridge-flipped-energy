export const BASE_URL = 'https://mcp-api.flipped.energy/developer/v1'
export const WAIT_TIMEOUT_S = 55
export const WAIT_HTTP_TIMEOUT_S = 70
export const HTTP_TIMEOUT_S = 60
export const DISPATCH_INTERVAL_S = 300
export const WAIT_HOLDS_PER_INTERVAL = 3
export const PRICE_STALE_AFTER_S = 900
export const ACCOUNT_MAX_AGE_S = 172800
export const SCAN_LIMIT_MIN = 1500
export const PLAN_CHANGE_HORIZON_DAYS = 31
export const KWH_UNLIMITED = 999999999
export const TIMER_MAX_AHEAD_S = 86400
export const USAGE_LOOKBACK_DAYS = 7
export const ACCOUNT_SYNC_LOCAL_TIME = '00:01:00'
export const USAGE_SYNC_LOCAL_TIME = '12:01:00'
export const TOKEN_EXPIRY_WARNING_DAYS = 14
export const RATE_KEY_SCALE = 1e9
export const RATE_OUTPUT_DIVISOR = 1e7
export const VECTOR_TOLERANCE = 1e-6

export const MINUTES_PER_DAY = 1440
export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60000
export const MS_PER_DAY = 86400000

export const FIXED_BILLING_UNIT = 'FixedBillingUnit'
export const SPOT_BILLING_UNIT = 'SpotBillingUnit'
export const SPOT_WITH_CAP_BILLING_UNIT = 'SpotWithCapBillingUnit'
export const KNOWN_BILLING_UNIT_TYPES: readonly string[] = [
  'CertificateBillingUnit',
  'ControlledLoadBillingUnit',
  'FeedInTariff',
  FIXED_BILLING_UNIT,
  'NetworkTariffBillingUnit',
  'PeriodicBillingUnit',
  'PrepaidBillingUnit',
  SPOT_BILLING_UNIT,
  SPOT_WITH_CAP_BILLING_UNIT,
]

export const SUPPLIED_ACCOUNT_STATES: readonly string[] = ['ACTIVE', 'CLOSING']
export const PRICE_TIERS: readonly string[] = ['UnusuallyLow', 'Normal', 'Elevated', 'Spike']
