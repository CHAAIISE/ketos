import { z } from "zod";

// Configure before schemas are constructed: the production CSP prohibits generated validators.
z.config({ jitless: true });
