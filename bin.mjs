#!/usr/bin/env node
import { install } from "./install.mjs";

const profiles = [];
let product;
try {
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] !== "--product") profiles.push(process.argv[index]);
    else if ((product = process.argv[++index]) === undefined) throw new Error("--product requires a value");
  }
  install(profiles, { product });
} catch (error) {
  process.stderr.write(`sessionbus-dsh-install: ${error.message}\n`);
  process.exitCode = 1;
}
