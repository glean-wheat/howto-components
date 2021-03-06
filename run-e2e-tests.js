/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint no-console: ["off"] */
const http = require('http');
const fs = require('mz/fs');
const express = require('express');
const seleniumAssistant = require('selenium-assistant');
const Mocha = require('mocha');

/**
 * `browserFilter` is used as an argument to `Array.prototype.filter` to filter
 * which browsers are used to run the e2e tests.
 */
function browserFilter(browser) {
  return browser.getReleaseName() === 'stable'
    && ['chrome'].includes(browser.getId());
}

/**
 * Start a webserver on an OS-chosen port serving the `docs` directory.
 * @returns A promise that resolves once the server is started.
 */
function startServer() {
  return new Promise(resolve => {
    const app = express();
    app.use(express.static('docs'));
    app.use(express.static('elements'));
    app.use(express.static('node_modules'));
    const server = http.createServer(app).listen();
    server.on('listening', _ => resolve(server));
  });
}

/**
 * `buildMocha` builds a new instance of the Mocha test runner that has sourced
 * all the e2e test files.
 * @returns A promise that resolves when Mocha is ready to run.
 */
async function buildMocha() {
  const mocha = new Mocha();
  // Get all element names we have
  const elements = await fs.readdir('elements');
  // Replace element name with empty string if it doesn’t have e2e tests.
  const filteredElements = await Promise.all(
    elements.map(async element => {
      const files = await fs.readdir(`elements/${element}/`);
      if (files.some(f => /\.e2etest\.js/.test(f)))
        return element;
      else
        return '';
    })
  );
  filteredElements
    // Filter out empty strings from the list (empty string is false-y).
    .filter(name => !!name)
    // Load e2e tests into Mocha instance.
    .forEach(name => mocha.addFile(`./elements/${name}/${name}.e2etest`));
  mocha.suite.timeout(60000);
  return new Promise(resolve => mocha.loadFiles(resolve))
    .then(_ => mocha);
}

function unsandboxChrome(browser) {
  const isChrome = browser.getReleaseName() === 'stable'
    && ['chrome'].includes(browser.getId());
  if (!isChrome)
    return browser;
  browser
    .getSeleniumOptions()
    // Disabling sandboxing is needed for Chrome to run in Docker (and Travis)
    .addArguments('--no-sandbox');
  return browser;
}

async function main() {
  // - Start a webserver to serve the docs so we can run the e2e tests on the
  // demos.
  // - require() all test suites.
  // - Open all stable browsers and get their webdriver.
  const [server, ...drivers] =
    await Promise.all([
      startServer(),
      ...seleniumAssistant.getLocalBrowsers()
        .filter(browserFilter)
        .map(unsandboxChrome)
        .map(b => {
          const driver = b.getSeleniumDriver();
          driver.manage().timeouts().setScriptTimeout(60000);
          return driver;
        }),
    ]);

  // We let the OS choose the port, so we need to assemble the URL here.
  const address = `http://localhost:${server.address().port}`;

  await runTests(address, drivers);

  console.log('Killing all browser instances...');
  await Promise.all(
    drivers.map(driver => seleniumAssistant.killWebDriver(driver))
  );
  server.close();
  console.log('Done.');
}

function runMocha(mocha) {
  return new Promise((resolve, reject) =>
    mocha.run(code =>
      code === 0?resolve():reject('Some tests failed')
  ));
}

async function runTests(address, drivers) {
  // Walk through all our drivers and run the suite on each of them.
  // We use `reduce()` to build a promise chain, which ensures that the tests
  // are run sequentially.
  return drivers
    .reduce(
      async (chain, driver) => {
        await chain;
        const mocha = await buildMocha();
        // Inject driver and server address into the test context
        mocha.suite.suites.forEach(s => {
          s.ctx.driver = driver;
          s.ctx.address = address;
        });
        await runMocha(mocha).then(_ => {});
      },
      Promise.resolve()
    );
}

main()
  .then(_ => console.log('e2e tests done.'))
  .catch(err => {
    console.error(err);
    if (err.stack)
      console.error(err.stack);
    process.exit(1);
  });
