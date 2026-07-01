import type { AuthenticatedUser } from './lib/auth.ts';

export interface HonoEnv {
  Variables: {
    user: AuthenticatedUser;
  };
}
