import type { RtcConfigurationDto } from "@p2p/contracts";

export type TurnCredential = {
  rtcConfiguration: RtcConfigurationDto;
  credentialExpiresAt: number;
};

export type TurnError = {
  code: "TURN_NOT_CONFIGURED" | "ROOM_EXPIRED";
  message: string;
};

export type TurnCredentialResult =
  | { ok: true; credential: TurnCredential }
  | { ok: false; error: TurnError };

export type CoturnConfigInput = {
  sharedSecret: string;
  realm: string;
  externalIp: string;
  certificatePath: string;
  privateKeyPath: string;
  listeningPort?: number;
  tlsListeningPort?: number;
  relayPortMin?: number;
  relayPortMax?: number;
};
