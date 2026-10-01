import { MS_PER_DAY, TOKEN_EXPIRY_WARNING_DAYS } from './constants.ts'
import { formatInstant, parseInstant } from './time.ts'
import {
  type AccountSignals,
  type Fault,
  type JsonRecord,
  type SignalConfig,
  type Snapshot,
  InvalidResponse,
  fault,
  noBodyFault,
  readArray,
  readNullableString,
  readRecord,
  readString,
} from './types.ts'

export interface SelectedAccount {
  accountNumber: string
  account: JsonRecord
  product: JsonRecord
  eligible: JsonRecord[]
}

export type Selection = { fault: Fault } | { selected: SelectedAccount }

export function selectAccount(body: unknown, config: SignalConfig): Selection {
  const root = readRecord(body, 'body')
  if (root.accounts === null || root.accounts === undefined) return { fault: fault('account_none', 'accounts is null or absent') }
  const accounts = readArray(root.accounts, 'accounts')
  const eligible: JsonRecord[] = []
  accounts.forEach((element, index) => {
    const account = readRecord(element, `accounts[${index}]`)
    const accountNumber = readNullableString(account.accountNumber, `accounts[${index}].accountNumber`)
    if (account.product === undefined) throw new InvalidResponse(`accounts[${index}].product: missing`)
    if (accountNumber === null || accountNumber === '' || account.product === null) return
    readRecord(account.product, `accounts[${index}].product`)
    eligible.push(account)
  })
  if (eligible.length === 0) return { fault: fault('account_none', `no eligible account among ${accounts.length}`) }
  const numbers = eligible.map((account) => readString(account.accountNumber, 'accountNumber'))
  let chosen: JsonRecord
  if (config.accountNumber !== null) {
    const index = numbers.indexOf(config.accountNumber)
    const found = eligible[index]
    if (found === undefined) return { fault: fault('account_not_found', `accountNumber ${config.accountNumber}`) }
    chosen = found
  } else {
    const only = eligible[0]
    if (eligible.length !== 1 || only === undefined) return { fault: fault('account_selection_required', `accounts ${numbers.join(', ')}`) }
    chosen = only
  }
  return {
    selected: {
      accountNumber: readString(chosen.accountNumber, 'accountNumber'),
      account: chosen,
      product: readRecord(chosen.product, 'product'),
      eligible,
    },
  }
}

export interface AccountResult {
  signals: AccountSignals
  tokenExpiresAtMs: number | null
}

export function faultedAccount(reason: Fault): AccountResult {
  return {
    signals: {
      status: 'faulted',
      fault: reason,
      accountNumber: null,
      accountState: null,
      productName: null,
      region: null,
      timeZone: null,
      tokenExpiresAt: null,
      tokenScope: null,
      tokenExpiringSoon: null,
    },
    tokenExpiresAtMs: null,
  }
}

interface TokenMatch {
  expiresAtMs: number
  scope: string
}

function findToken(tokens: Snapshot, tokenPreview: string | null): TokenMatch | null {
  if (tokens.body === null || tokenPreview === null) return null
  const root = readRecord(tokens.body, 'tokens body')
  const list = readArray(root.tokens, 'tokens')
  for (const [index, element] of list.entries()) {
    const token = readRecord(element, `tokens[${index}]`)
    if (readString(token.tokenPreview, `tokens[${index}].tokenPreview`) !== tokenPreview) continue
    const expiresText = readString(token.expiresAt, `tokens[${index}].expiresAt`)
    const expiresAtMs = parseInstant(expiresText)
    if (expiresAtMs === null) throw new InvalidResponse(`tokens[${index}].expiresAt: not an ISO-8601 instant: ${JSON.stringify(expiresText)}`)
    return { expiresAtMs: Math.floor(expiresAtMs / 1000) * 1000, scope: readString(token.scope, `tokens[${index}].scope`) }
  }
  return null
}

function computeAccountGroup(instantMs: number, config: SignalConfig, account: Snapshot, tokens: Snapshot): AccountResult {
  const missing = noBodyFault(account)
  if (missing !== null) return faultedAccount(missing)
  const selection = selectAccount(account.body, config)
  if ('fault' in selection) return faultedAccount(selection.fault)
  const { selected } = selection
  const accountState = readString(selected.account.accountState, 'accountState')
  const productName = readNullableString(selected.account.productName, 'productName')
  const region = readNullableString(selected.product.gridType, 'product.gridType')
  const timeZone = readNullableString(selected.product.timeZone, 'product.timeZone')
  const token = findToken(tokens, config.tokenPreview)
  return {
    signals: {
      status: 'ok',
      fault: null,
      accountNumber: selected.accountNumber,
      accountState,
      productName,
      region,
      timeZone,
      tokenExpiresAt: token === null ? null : formatInstant(token.expiresAtMs),
      tokenScope: token === null ? null : token.scope,
      tokenExpiringSoon: token === null ? null : token.expiresAtMs - instantMs < TOKEN_EXPIRY_WARNING_DAYS * MS_PER_DAY,
    },
    tokenExpiresAtMs: token === null ? null : token.expiresAtMs,
  }
}

export function accountGroup(instantMs: number, config: SignalConfig, account: Snapshot, tokens: Snapshot): AccountResult {
  try {
    return computeAccountGroup(instantMs, config, account, tokens)
  } catch (error) {
    if (error instanceof InvalidResponse) return faultedAccount(fault('invalid_response', error.message))
    throw error
  }
}
