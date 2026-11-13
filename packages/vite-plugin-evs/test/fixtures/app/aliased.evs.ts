/// <reference types="vite/client" />

/** Imports through an alias of the app's config, and reads the mode the build runs in. */
import { MIN } from '~limits';

export const min = MIN;
export const mode = import.meta.env.MODE;
