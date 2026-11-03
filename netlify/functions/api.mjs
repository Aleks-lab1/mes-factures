import { getStore } from "@netlify/blobs";
import { createHandler } from "../lib/server.mjs";

export default createHandler(() => getStore({ name: "mes-factures", consistency: "strong" }));

export const config = { path: "/api/*" };
