import type { API } from 'homebridge'
import { FlippedEnergyPlatform } from './platform.ts'
import { PLATFORM_NAME } from './settings.ts'

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, FlippedEnergyPlatform)
}
