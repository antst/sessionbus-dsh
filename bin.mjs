#!/usr/bin/env node
import { install, remove } from "./install.mjs";

const profiles = [];
let product;
let removing = false;
try {
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === "--remove") removing = true;
    else if (process.argv[index] !== "--product") profiles.push(process.argv[index]);
    else if ((product = process.argv[++index]) === undefined) throw new Error("--product requires a value");
  }
  if (removing) remove(profiles);
  else install(profiles, { product });
} catch (error) {
  process.stderr.write(`sessionbus-dsh-install: ${error.message}\n`);
  process.exitCode = error.exitCode ?? 1;
}
