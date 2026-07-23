use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
};

use tokio::process::Command;

const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_PATH_COMPONENT_BYTES: usize = 4 * 1024;
const MAX_PATH_COMPONENTS: usize = 128;

const COMMON_SCALARS: &[&str] = &[
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
];

const UNIX_SCALARS: &[&str] = &[
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
];

const WINDOWS_SCALARS: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
];

const ABSOLUTE_TOOLCHAIN_ROOTS: &[&str] = &[
    "CARGO_HOME",
    "RUSTUP_HOME",
    "PNPM_HOME",
    "COREPACK_HOME",
    "VOLTA_HOME",
    "NVM_HOME",
    "NVM_SYMLINK",
    "JAVA_HOME",
    "GRADLE_USER_HOME",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "DOTNET_ROOT",
    "GOPATH",
    "GOROOT",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChildKind {
    AgentShell,
    ReadOnlyGit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ValuePolicy {
    Scalar,
    Path,
    AbsolutePath,
}

/// Construct an app-owned child with the reviewed environment and Windows
/// no-console policy applied together. Production callers should use this
/// boundary instead of constructing `Command` directly.
pub(crate) fn child_command<S: AsRef<OsStr>>(program: S, kind: ChildKind) -> Command {
    let mut command = hidden_command(program);
    apply_to_tokio(&mut command, kind);
    command
}

/// Construct a helper that must inherit the host environment but still must
/// not allocate a visible console from the packaged Windows GUI application.
pub(crate) fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = {
        let mut command = command;
        hide_windows_console(&mut command);
        command
    };
    command
}

/// Clears a Tokio child process environment and installs only the reviewed
/// variables for `kind`.
fn apply_to_tokio(command: &mut Command, kind: ChildKind) {
    command.env_clear();
    command.envs(sanitized_environment(kind));
}

/// Prevent console-subsystem children from allocating a visible window when
/// Portcode is running as a packaged Windows GUI application.
#[cfg(windows)]
fn hide_windows_console(command: &mut Command) {
    command.creation_flags(windows_no_console_creation_flags());
}

#[cfg(any(windows, test))]
const fn windows_no_console_creation_flags() -> u32 {
    // CREATE_NO_WINDOW from WinBase.h. Tokio exposes a safe inherent setter,
    // which keeps this compatible with the crate's `unsafe_code = "deny"`.
    0x0800_0000
}

pub(crate) fn sanitized_environment(kind: ChildKind) -> Vec<(OsString, OsString)> {
    sanitized_environment_from(std::env::vars_os(), kind, cfg!(windows))
}

/// Resolves a single executable filename only within the scrubbed, absolute
/// `PATH` passed to app-owned children.
pub(crate) fn resolve_in_sanitized_path(executable: &OsStr, kind: ChildKind) -> Option<PathBuf> {
    resolve_in_environment_path(executable, &sanitized_environment(kind))
}

fn sanitized_environment_from<I, K, V>(
    source: I,
    kind: ChildKind,
    windows_names: bool,
) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<OsString>,
    V: Into<OsString>,
{
    let mut sanitized = BTreeMap::<String, OsString>::new();

    for (name, value) in source {
        let name = name.into();
        let value = value.into();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some((canonical_name, policy)) = policy_for(name, windows_names) else {
            continue;
        };
        let Some(value) = sanitize_value(&value, policy) else {
            continue;
        };
        sanitized.insert(canonical_name.to_owned(), value);
    }

    if kind == ChildKind::ReadOnlyGit {
        sanitized.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        sanitized.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
        sanitized.insert("LC_ALL".into(), "C".into());
    }

    sanitized
        .into_iter()
        .map(|(name, value)| (name.into(), value))
        .collect()
}

fn policy_for(name: &str, windows_names: bool) -> Option<(&'static str, ValuePolicy)> {
    if names_equal(name, "PATH", windows_names) {
        return Some(("PATH", ValuePolicy::Path));
    }

    for &candidate in COMMON_SCALARS {
        if names_equal(name, candidate, windows_names) {
            return Some((candidate, ValuePolicy::Scalar));
        }
    }

    let platform_scalars = if windows_names {
        WINDOWS_SCALARS
    } else {
        UNIX_SCALARS
    };
    for &candidate in platform_scalars {
        if names_equal(name, candidate, windows_names) {
            return Some((candidate, ValuePolicy::Scalar));
        }
    }

    for &candidate in ABSOLUTE_TOOLCHAIN_ROOTS {
        if names_equal(name, candidate, windows_names) {
            return Some((candidate, ValuePolicy::AbsolutePath));
        }
    }

    None
}

fn names_equal(actual: &str, expected: &str, windows_names: bool) -> bool {
    if windows_names {
        actual.eq_ignore_ascii_case(expected)
    } else {
        actual == expected
    }
}

fn sanitize_value(value: &OsStr, policy: ValuePolicy) -> Option<OsString> {
    match policy {
        ValuePolicy::Scalar => (!value.is_empty() && encoded_len(value) <= MAX_ENV_VALUE_BYTES)
            .then(|| value.to_os_string()),
        ValuePolicy::Path => sanitize_path(value),
        ValuePolicy::AbsolutePath => (!value.is_empty()
            && encoded_len(value) <= MAX_PATH_COMPONENT_BYTES
            && Path::new(value).is_absolute())
        .then(|| value.to_os_string()),
    }
}

fn sanitize_path(value: &OsStr) -> Option<OsString> {
    let mut retained = Vec::new();
    let mut retained_bytes = 0usize;

    for component in std::env::split_paths(value).take(MAX_PATH_COMPONENTS) {
        let component_len = encoded_len(component.as_os_str());
        let separator_len = usize::from(!retained.is_empty());
        if component.as_os_str().is_empty()
            || !component.is_absolute()
            || component_len > MAX_PATH_COMPONENT_BYTES
            || retained_bytes
                .saturating_add(separator_len)
                .saturating_add(component_len)
                > MAX_PATH_BYTES
        {
            continue;
        }

        retained_bytes += separator_len + component_len;
        retained.push(component);
    }

    if retained.is_empty() {
        return None;
    }

    std::env::join_paths(retained).ok()
}

fn encoded_len(value: &OsStr) -> usize {
    value.as_encoded_bytes().len()
}

fn resolve_in_environment_path(
    executable: &OsStr,
    environment: &[(OsString, OsString)],
) -> Option<PathBuf> {
    let mut components = Path::new(executable).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return None;
    }

    let path = environment
        .iter()
        .find_map(|(name, value)| (name == OsStr::new("PATH")).then_some(value))?;

    std::env::split_paths(path)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, fs, path::PathBuf};

    fn as_map(values: Vec<(OsString, OsString)>) -> BTreeMap<OsString, OsString> {
        values.into_iter().collect()
    }

    fn platform_absolute_path(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\{name}"))
        } else {
            PathBuf::from(format!("/{name}"))
        }
    }

    #[test]
    fn no_console_policy_uses_create_no_window() {
        assert_eq!(windows_no_console_creation_flags(), 0x0800_0000);
    }

    #[test]
    fn production_children_use_the_central_process_boundary() {
        let mut pending = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        let mut violations = Vec::new();

        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory).expect("Rust source directory must be readable") {
                let path = entry.expect("source entry must be readable").path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension() != Some(OsStr::new("rs"))
                    || path.file_name() == Some(OsStr::new("process_env.rs"))
                {
                    continue;
                }

                let source = fs::read_to_string(&path).expect("Rust source must be UTF-8");
                let test_module = source
                    .find("#[cfg(test)]\nmod tests")
                    .or_else(|| source.find("#[cfg(test)]\r\nmod tests"));
                let production = test_module.map_or(source.as_str(), |index| &source[..index]);
                if production.contains("Command::new(") {
                    violations.push(
                        path.strip_prefix(env!("CARGO_MANIFEST_DIR"))
                            .unwrap_or(&path)
                            .display()
                            .to_string(),
                    );
                }
            }
        }

        assert!(
            violations.is_empty(),
            "production child processes must use process_env::child_command or \
             process_env::hidden_command; direct constructors found in: {}",
            violations.join(", ")
        );
    }

    #[test]
    fn exact_allowlist_drops_credentials_injection_and_prefix_families() {
        let source = [
            ("HOME", "/safe/home"),
            ("LANG", "en_US.UTF-8"),
            ("ANTHROPIC_API_KEY", "planted-secret"),
            ("AWS_SECRET_ACCESS_KEY", "planted-secret"),
            ("HTTPS_PROXY", "https://user:secret@example.invalid"),
            ("LD_PRELOAD", "/tmp/inject.so"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/inject.dylib"),
            ("NODE_OPTIONS", "--require /tmp/inject.js"),
            ("NPM_CONFIG_TOKEN", "planted-secret"),
            ("PSExecutionPolicyPreference", "Unrestricted"),
            ("GIT_CONFIG_COUNT", "1"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
        ];

        let environment = as_map(sanitized_environment_from(
            source,
            ChildKind::AgentShell,
            false,
        ));

        assert_eq!(
            environment.get(OsStr::new("HOME")),
            Some(&"/safe/home".into())
        );
        assert_eq!(
            environment.get(OsStr::new("LANG")),
            Some(&"en_US.UTF-8".into())
        );
        assert_eq!(environment.len(), 2);
    }

    #[test]
    fn windows_names_are_ascii_case_insensitive_but_unix_names_are_exact() {
        let source = [("hOmE", r"C:\Users\safe"), ("lAnG", "en-US")];

        let windows = as_map(sanitized_environment_from(
            source,
            ChildKind::AgentShell,
            true,
        ));
        assert_eq!(
            windows.get(OsStr::new("HOME")),
            Some(&r"C:\Users\safe".into())
        );
        assert_eq!(windows.get(OsStr::new("LANG")), Some(&"en-US".into()));

        let unix = sanitized_environment_from(source, ChildKind::AgentShell, false);
        assert!(unix.is_empty());
    }

    #[test]
    fn path_keeps_only_bounded_absolute_nonempty_components() {
        let first = platform_absolute_path("first");
        let second = platform_absolute_path("second");
        let oversized = platform_absolute_path(&"x".repeat(MAX_PATH_COMPONENT_BYTES + 1));
        let source_path = std::env::join_paths([
            first.as_path(),
            Path::new("relative"),
            Path::new(""),
            oversized.as_path(),
            second.as_path(),
        ])
        .expect("test path must join");

        let environment = as_map(sanitized_environment_from(
            [(OsString::from("PATH"), source_path)],
            ChildKind::AgentShell,
            cfg!(windows),
        ));
        let retained: Vec<_> = std::env::split_paths(
            environment
                .get(OsStr::new("PATH"))
                .expect("PATH must survive"),
        )
        .collect();

        assert_eq!(retained, vec![first, second]);
    }

    #[test]
    fn path_component_count_is_bounded() {
        let components: Vec<_> = (0..MAX_PATH_COMPONENTS + 2)
            .map(|index| platform_absolute_path(&format!("path-{index}")))
            .collect();
        let source_path = std::env::join_paths(&components).expect("test path must join");
        let environment = as_map(sanitized_environment_from(
            [(OsString::from("PATH"), source_path)],
            ChildKind::AgentShell,
            cfg!(windows),
        ));
        let retained = std::env::split_paths(
            environment
                .get(OsStr::new("PATH"))
                .expect("PATH must survive"),
        )
        .count();

        assert_eq!(retained, MAX_PATH_COMPONENTS);
    }

    #[test]
    fn toolchain_roots_must_be_absolute_and_bounded() {
        let absolute = platform_absolute_path("cargo-home");
        let oversized = platform_absolute_path(&"x".repeat(MAX_PATH_COMPONENT_BYTES + 1));
        let environment = as_map(sanitized_environment_from(
            [
                (OsString::from("CARGO_HOME"), absolute.as_os_str().into()),
                (OsString::from("RUSTUP_HOME"), OsString::from("relative")),
                (OsString::from("PNPM_HOME"), oversized.into_os_string()),
            ],
            ChildKind::AgentShell,
            cfg!(windows),
        ));

        assert_eq!(
            environment.get(OsStr::new("CARGO_HOME")),
            Some(&absolute.into_os_string())
        );
        assert!(!environment.contains_key(OsStr::new("RUSTUP_HOME")));
        assert!(!environment.contains_key(OsStr::new("PNPM_HOME")));
    }

    #[test]
    fn executable_resolution_uses_only_sanitized_path_and_rejects_path_fragments() {
        let current_exe = std::env::current_exe().expect("current test executable must resolve");
        let directory = current_exe
            .parent()
            .expect("current test executable must have a parent");
        let executable = current_exe
            .file_name()
            .expect("current test executable must have a filename");
        let environment = sanitized_environment_from(
            [
                (
                    OsString::from("PATH"),
                    std::env::join_paths([directory]).unwrap(),
                ),
                (
                    OsString::from("API_TOKEN"),
                    OsString::from("planted-secret"),
                ),
            ],
            ChildKind::AgentShell,
            cfg!(windows),
        );

        assert_eq!(
            resolve_in_environment_path(executable, &environment),
            Some(current_exe.clone())
        );
        assert!(resolve_in_environment_path(OsStr::new("../escape"), &environment).is_none());
        assert!(resolve_in_environment_path(current_exe.as_os_str(), &environment).is_none());
        assert!(
            resolve_in_environment_path(OsStr::new("definitely-not-portcode"), &environment)
                .is_none()
        );
    }

    #[test]
    fn read_only_git_adds_only_portcode_owned_git_variables() {
        let environment = as_map(sanitized_environment_from(
            [
                ("LC_ALL", "host-locale"),
                ("GIT_DIR", "/tmp/attacker-controlled"),
                ("GIT_CONFIG_PARAMETERS", "credential.helper=evil"),
                ("GIT_ASKPASS", "/tmp/askpass"),
            ],
            ChildKind::ReadOnlyGit,
            false,
        ));

        assert_eq!(environment.get(OsStr::new("LC_ALL")), Some(&"C".into()));
        assert_eq!(
            environment.get(OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(&"0".into())
        );
        assert_eq!(
            environment.get(OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(&"0".into())
        );
        assert_eq!(environment.len(), 3);
    }

    #[tokio::test]
    async fn env_clear_boundary_removes_planted_values_from_a_real_child() {
        #[cfg(windows)]
        let mut command = {
            let system_root = std::env::var_os("SystemRoot").expect("SystemRoot must be set");
            let mut command =
                Command::new(Path::new(&system_root).join("System32").join("cmd.exe"));
            command.raw_arg("/D /S /C set");
            command
        };
        #[cfg(not(windows))]
        let mut command = Command::new("/usr/bin/env");

        command
            .env("PORTCODE_TEST_SECRET", "planted-secret")
            .env("GIT_CONFIG_COUNT", "99");
        apply_to_tokio(&mut command, ChildKind::ReadOnlyGit);
        let output = command.output().await.expect("environment child must run");
        assert!(
            output.status.success(),
            "environment child exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let environment = String::from_utf8_lossy(&output.stdout);
        assert!(!environment.contains("PORTCODE_TEST_SECRET"));
        assert!(!environment.contains("planted-secret"));
        assert!(!environment.contains("GIT_CONFIG_COUNT"));
        assert!(environment.contains("GIT_OPTIONAL_LOCKS=0"));
        assert!(environment.contains("GIT_TERMINAL_PROMPT=0"));
        assert!(environment.contains("LC_ALL=C"));
    }
}
