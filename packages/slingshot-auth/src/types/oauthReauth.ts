export interface OAuthReauthState {
  userId: string;
  sessionId: string;
  provider: string;
  /** e.g. "delete_account", "change_password" */
  purpose: string;
  expiresAt: number;
  returnUrl?: string;
}

export interface OAuthReauthConfirmation {
  userId: string;
  purpose: string;
}
