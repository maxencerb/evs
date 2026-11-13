/** Takes a run-time helper from the main entry, in an app without any build-time module. */
import { decodeScriptError } from '@maxencerb/evs';

export const decode = (error: unknown) => decodeScriptError({ abi: [] }, error);
