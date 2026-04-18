import type { WsEndpointConfig } from '../../config/types/ws';

/** Subset of WsEndpointConfig needed for recovery. */
export interface RecoverableEndpointConfig {
  recovery?: import('@lastshotlabs/slingshot-core').WsRecoveryConfig;
  persistence?: WsEndpointConfig['persistence'];
}
