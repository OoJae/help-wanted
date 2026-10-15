#!/usr/bin/env node
// The runner and the shared package it uses are TypeScript sources, which plain `node` cannot
// import. This launcher registers tsx and then runs the command line, so `hw-runner` works as a
// command. It reads no settings itself: everything comes from the environment (see .env.example).
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
