#!/usr/bin/env node

/**
 * End-to-end smoke test against a real Android device or emulator.
 *
 * Launches the built MCP server (dist/index.js) over stdio and drives the real
 * tools: create a session on the Settings app, take a screenshot, find an
 * element, tap it, and delete the session. The session is always deleted, even
 * when an earlier step fails.
 *
 * Usage:
 *   npm run build
 *   node scripts/android-smoke.mjs                       # embedded UiAutomator2 driver (default mode)
 *   node scripts/android-smoke.mjs --remote-server-url=http://127.0.0.1:4723
 *   node scripts/android-smoke.mjs --dry-run             # no device: check tool names and argument shapes only
 *
 * Environment overrides:
 *   ANDROID_SERIAL               udid of the device to use when several are connected
 *   ANDROID_SMOKE_APP_PACKAGE    app to launch (default com.android.settings)
 *   ANDROID_SMOKE_APP_ACTIVITY   activity to launch (default .Settings)
 *   ANDROID_SMOKE_SELECTOR       -android uiautomator selector of the element to tap
 *                                (default: first Settings list title, with fallbacks)
 *   ANDROID_SMOKE_SERVER_LOG     file to append the MCP server's stderr log to
 *   ANDROID_SMOKE_TIMEOUT_MS     per-tool-call timeout (default 300000)
 */

import {createWriteStream, existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SCREENSHOT_MAX_WIDTH = 360;

/**
 * Default elements to tap, most specific first. All are scoped to the app under
 * test, so a system dialog in front of it fails the step instead of being tapped.
 */
function defaultSelectors(pkg) {
  const scope = `new UiSelector().packageName("${pkg}")`;
  return [
    `${scope}.resourceId("android:id/title")`,
    `${scope}.textContains("Network")`,
    `${scope}.className("android.widget.TextView")`,
  ];
}

/** "<App> isn't responding" (ANR) dialogs, common right after an emulator boots. */
const ANR_WAIT_BUTTON = 'new UiSelector().resourceId("android:id/aerr_wait")';
const MAX_DIALOG_DISMISSALS = 3;

/** Every tool call this script makes, with the argument names it passes. */
const TOOL_CONTRACT = {
  select_device: ['platform', 'deviceUdid'],
  appium_session_management: ['action', 'platform', 'capabilities', 'remoteServerUrl', 'sessionId'],
  appium_screenshot: ['returnRawBase64', 'maxWidth', 'sessionId'],
  appium_find_element: ['strategy', 'selector', 'sessionId'],
  appium_get_text: ['elementUUID', 'sessionId'],
  appium_gesture: ['action', 'elementUUID', 'sessionId'],
};

class StepError extends Error {
  constructor(step, message) {
    super(`[${step}] ${message}`);
    this.step = step;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');
const serverEntry = join(projectRoot, 'dist', 'index.js');

const {values: options} = parseArgs({
  options: {
    'remote-server-url': {type: 'string'},
    'dry-run': {type: 'boolean', default: false},
  },
});

const remoteServerUrl = options['remote-server-url'] || process.env.ANDROID_SMOKE_REMOTE_SERVER_URL || undefined;
const dryRun = options['dry-run'];
const timeout = Number(process.env.ANDROID_SMOKE_TIMEOUT_MS) || 300_000;
const appPackage = process.env.ANDROID_SMOKE_APP_PACKAGE || 'com.android.settings';
const appActivity = process.env.ANDROID_SMOKE_APP_ACTIVITY || '.Settings';
const selectors = process.env.ANDROID_SMOKE_SELECTOR
  ? [process.env.ANDROID_SMOKE_SELECTOR]
  : defaultSelectors(appPackage);
const mode = remoteServerUrl ? `remote (${remoteServerUrl})` : 'embedded';

if (!existsSync(serverEntry)) {
  console.error(`Built server not found at ${serverEntry}. Run "npm run build" first.`);
  process.exit(1);
}

function log(message) {
  console.log(`[android-smoke] ${message}`);
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

async function callTool(client, step, name, args) {
  log(`${step}: ${name} ${JSON.stringify(args)}`);
  let result;
  try {
    result = await client.callTool({name, arguments: args}, undefined, {timeout, resetTimeoutOnProgress: true});
  } catch (err) {
    throw new StepError(step, `${name} request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.isError) {
    throw new StepError(step, `${name} returned an error:\n${textOf(result) || JSON.stringify(result)}`);
  }
  return result;
}

async function checkToolContract(client) {
  const {tools} = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const problems = [];
  for (const [name, argNames] of Object.entries(TOOL_CONTRACT)) {
    const tool = byName.get(name);
    if (!tool) {
      problems.push(`tool ${name} is not registered`);
      continue;
    }
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    for (const argName of argNames) {
      if (!properties.includes(argName)) {
        problems.push(`tool ${name} has no "${argName}" argument (has: ${properties.join(', ')})`);
      }
    }
  }
  if (problems.length > 0) {
    throw new StepError('tool contract', problems.join('\n'));
  }
  log(`tool contract: ${Object.keys(TOOL_CONTRACT).length} tools and their arguments are registered`);
}

async function createSession(client) {
  if (!remoteServerUrl) {
    const selectArgs = {platform: 'android'};
    if (process.env.ANDROID_SERIAL) {
      selectArgs.deviceUdid = process.env.ANDROID_SERIAL;
    }
    const selected = await callTool(client, 'select device', 'select_device', selectArgs);
    log(`select device: ${textOf(selected).split('\n')[0]}`);
  }

  const capabilities = {
    'appium:appPackage': appPackage,
    'appium:appActivity': appActivity,
    'appium:noReset': true,
    'appium:adbExecTimeout': 60_000,
    'appium:uiautomator2ServerInstallTimeout': 120_000,
    'appium:uiautomator2ServerLaunchTimeout': 120_000,
  };
  if (remoteServerUrl) {
    capabilities.platformName = 'Android';
    capabilities['appium:automationName'] = 'UiAutomator2';
    capabilities['appium:deviceName'] = 'Android Emulator';
    if (process.env.ANDROID_SERIAL) {
      capabilities['appium:udid'] = process.env.ANDROID_SERIAL;
    }
  }

  const args = {action: 'create', platform: 'android', capabilities: JSON.stringify(capabilities)};
  if (remoteServerUrl) {
    args.remoteServerUrl = remoteServerUrl;
  }
  const result = await callTool(client, 'create session', 'appium_session_management', args);
  const text = textOf(result);
  const sessionId = text.match(/session created successfully with ID: (\S+)/)?.[1];
  if (!sessionId || sessionId === 'Unknown') {
    throw new StepError('create session', `could not read a session ID from the response:\n${text}`);
  }
  log(`create session: ${sessionId}`);
  return sessionId;
}

/** Width in pixels from a PNG's IHDR chunk, or undefined if the buffer is not a PNG. */
function pngWidth(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  return bytes.readUInt32BE(16);
}

async function takeScreenshots(client, sessionId) {
  // Inline image, resized through sharp so image processing is exercised as well.
  const raw = await callTool(client, 'screenshot (inline)', 'appium_screenshot', {
    returnRawBase64: true,
    maxWidth: SCREENSHOT_MAX_WIDTH,
    sessionId,
  });
  const image = raw.content?.find((item) => item.type === 'image');
  if (!image?.data) {
    throw new StepError(
      'screenshot (inline)',
      `no image content in the response: ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }
  const bytes = Buffer.from(image.data, 'base64');
  const inlineWidth = pngWidth(bytes);
  if (inlineWidth === undefined) {
    throw new StepError('screenshot (inline)', `image is not a non-empty PNG (${bytes.length} bytes)`);
  }
  if (inlineWidth > SCREENSHOT_MAX_WIDTH) {
    throw new StepError(
      'screenshot (inline)',
      `image is ${inlineWidth}px wide although maxWidth=${SCREENSHOT_MAX_WIDTH} was requested`,
    );
  }
  log(`screenshot (inline): ${image.mimeType}, ${inlineWidth}px wide, ${bytes.length} bytes`);

  // Default mode: the server saves the PNG to disk and returns its path.
  const saved = await callTool(client, 'screenshot (file)', 'appium_screenshot', {sessionId});
  const filepath = textOf(saved)
    .match(/saved successfully to: (.+)/)?.[1]
    ?.trim();
  if (!filepath || !existsSync(filepath) || statSync(filepath).size === 0) {
    throw new StepError('screenshot (file)', `screenshot file missing or empty: ${textOf(saved)}`);
  }
  const fullWidth = pngWidth(readFileSync(filepath));
  log(`screenshot (file): ${filepath}, ${fullWidth}px wide, ${statSync(filepath).size} bytes`);
  if (fullWidth !== undefined && fullWidth <= SCREENSHOT_MAX_WIDTH) {
    log(`warning: the screen is only ${fullWidth}px wide, so maxWidth=${SCREENSHOT_MAX_WIDTH} did not resize anything`);
  }
}

/** Tap "Wait" on any ANR dialog covering the app, so the next steps see the app itself. */
async function dismissSystemDialogs(client, sessionId) {
  for (let attempt = 1; attempt <= MAX_DIALOG_DISMISSALS; attempt++) {
    const found = await client.callTool(
      {
        name: 'appium_find_element',
        arguments: {strategy: '-android uiautomator', selector: ANR_WAIT_BUTTON, sessionId},
      },
      undefined,
      {timeout},
    );
    if (found.isError) {
      return;
    }
    const buttonId = textOf(found).match(/^elementId '([^']+)'/m)?.[1];
    if (!buttonId) {
      return;
    }
    log(`dismiss dialog: an "isn't responding" dialog is showing, tapping Wait (${attempt}/${MAX_DIALOG_DISMISSALS})`);
    await callTool(client, 'dismiss dialog', 'appium_gesture', {action: 'tap', elementUUID: buttonId, sessionId});
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new StepError(
    'dismiss dialog',
    `an "isn't responding" dialog was still showing after ${MAX_DIALOG_DISMISSALS} taps on Wait`,
  );
}

async function findElement(client, sessionId) {
  const failures = [];
  for (const selector of selectors) {
    const args = {strategy: '-android uiautomator', selector, sessionId};
    log(`find element: appium_find_element ${JSON.stringify(args)}`);
    let result;
    try {
      result = await client.callTool({name: 'appium_find_element', arguments: args}, undefined, {timeout});
    } catch (err) {
      failures.push(`${selector}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (result.isError) {
      failures.push(`${selector}: ${textOf(result).split('\n')[0]}`);
      continue;
    }
    const elementId = textOf(result).match(/^elementId '([^']+)'/m)?.[1];
    if (!elementId) {
      throw new StepError('find element', `no elementId in the response:\n${textOf(result)}`);
    }
    log(`find element: ${elementId} (${selector})`);
    return elementId;
  }
  throw new StepError('find element', `no selector matched an element:\n${failures.join('\n')}`);
}

async function main() {
  log(`mode: ${dryRun ? 'dry run' : mode}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      NO_UI: 'true',
      AI_VISION_ENABLED: 'false',
      APPIUM_MCP_DOCS_ENABLED: 'false',
      APPIUM_MCP_OTEL_ENABLED: 'false',
    },
    stderr: 'pipe',
  });
  const serverLog = process.env.ANDROID_SMOKE_SERVER_LOG
    ? createWriteStream(process.env.ANDROID_SMOKE_SERVER_LOG, {flags: 'a'})
    : null;
  transport.stderr?.on('data', (chunk) => serverLog?.write(chunk));

  const client = new Client({name: 'appium-mcp-android-smoke', version: '1.0.0'});
  let sessionId;
  let failure;
  try {
    try {
      await client.connect(transport);
    } catch (err) {
      throw new StepError('start server', err instanceof Error ? err.message : String(err));
    }
    await checkToolContract(client);
    if (dryRun) {
      return;
    }
    sessionId = await createSession(client);
    await takeScreenshots(client, sessionId);
    await dismissSystemDialogs(client, sessionId);
    const elementId = await findElement(client, sessionId);
    const text = await callTool(client, 'get text', 'appium_get_text', {elementUUID: elementId, sessionId});
    log(`get text: ${textOf(text).split('\n').slice(1).join(' ')}`);
    await callTool(client, 'tap', 'appium_gesture', {action: 'tap', elementUUID: elementId, sessionId});
    log('tap: done');
  } catch (err) {
    failure = err;
  } finally {
    if (sessionId) {
      try {
        await callTool(client, 'delete session', 'appium_session_management', {action: 'delete', sessionId});
        log(`delete session: ${sessionId} deleted`);
      } catch (err) {
        if (failure) {
          // Keep the original failure as the reported cause, but do not hide this one.
          console.error(`[android-smoke] cleanup also failed: ${err.message}`);
        }
        failure ??= err;
      }
    }
    await client.close().catch(() => {});
    serverLog?.end();
  }

  if (failure) {
    const message = failure instanceof StepError ? failure.message : (failure?.stack ?? String(failure));
    console.error(`[android-smoke] FAILED (${mode}) ${message}`);
    process.exitCode = 1;
    return;
  }
  log(dryRun ? 'dry run passed' : `all steps passed (${mode})`);
}

await main();
