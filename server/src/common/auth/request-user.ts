import { ApiKeyScopes } from '../../database/database.types';

/** Authenticated principal attached to `req.user` by the auth guard. */
export interface RequestUser {
  id: string;
  email: string;
  isAdmin: boolean;
  /** How the request authenticated. */
  authVia: 'session' | 'apikey';
  /** Present only for API-key auth; effective rights = user ∩ scopes. */
  apiKeyScopes?: ApiKeyScopes;
  apiKeyId?: string;
}

/** Authenticated agent attached to `req.agent` by the agent auth guard. */
export interface RequestAgent {
  id: string;
  name: string;
}
