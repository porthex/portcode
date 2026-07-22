import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  new URL("../src-tauri/installer/installer.nsi", import.meta.url),
  "utf8",
);

function between(start, end) {
  const from = template.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = template.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return template.slice(from, to);
}

test("beta upgrades close and immediately remove legacy executables", () => {
  const install = between("Section Install", "SectionEnd");
  const copy = install.indexOf('File "${MAINBINARYSRCPATH}"');
  const legacyProcessCheck = install.indexOf(
    '!insertmacro CheckIfAppIsRunning "${PORTCODE_LEGACY_BETA_BINARY}"',
  );
  const legacyDelete = install.indexOf('Delete "$INSTDIR\\${PORTCODE_LEGACY_BETA_BINARY}"');

  assert.ok(legacyProcessCheck > -1 && legacyProcessCheck < copy);
  assert.ok(legacyDelete > copy);
  assert.match(install, /Delete "\$INSTDIR\\\$OldMainBinaryName"/);
  assert.doesNotMatch(install, /Delete \/REBOOTOK "\$INSTDIR\\\$OldMainBinaryName"/);
  assert.match(install, /Setup could not remove the legacy/);
});

test("every install mode migrates an existing desktop shortcut", () => {
  const install = between("Section Install", "SectionEnd");
  const unconditionalMigration = install.indexOf("Call MigrateExistingDesktopShortcut");
  const passiveOnlyCreation = install.indexOf("${If} $PassiveMode = 1");
  const migration = between("Function MigrateExistingDesktopShortcut", "FunctionEnd");

  assert.ok(unconditionalMigration > -1);
  assert.ok(unconditionalMigration < passiveOnlyCreation);
  assert.match(migration, /\$INSTDIR\\\$OldMainBinaryName/);
  assert.match(migration, /\$INSTDIR\\\$\{PORTCODE_LEGACY_BETA_BINARY\}/);
  assert.match(migration, /SetShortcutTarget/);
});

test("uninstall removes legacy binaries and shortcuts too", () => {
  const uninstall = between("Section Uninstall", "SectionEnd");

  assert.match(uninstall, /CheckIfAppIsRunning "\$\{PORTCODE_LEGACY_BETA_BINARY\}"/);
  assert.match(uninstall, /Delete "\$INSTDIR\\\$\{PORTCODE_LEGACY_BETA_BINARY\}"/);
  assert.match(
    uninstall,
    /IsShortcutTarget "\$DESKTOP\\\$\{PRODUCTNAME\}\.lnk" "\$INSTDIR\\\$\{PORTCODE_LEGACY_BETA_BINARY\}"/,
  );
});
