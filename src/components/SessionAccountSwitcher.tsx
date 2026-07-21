import { useMemo, useState } from "react";

import { modelsForOpenAIProfile, preferredOpenAIAccount, useStore } from "../store/store";
import { openAIAccountLabel, type Session } from "../types";
import { SelectMenu, type SelectMenuGroup } from "./SelectMenu";
import { SessionActionDialog } from "./SessionActionDialog";

/**
 * Session-scoped ChatGPT account selection. The native command is authoritative:
 * it atomically accepts changes before the first durable message and reports a
 * locked result afterward, including when another window wins the race.
 */
export function SessionAccountSwitcher({ session }: { session: Session }) {
  const accounts = useStore((state) => state.openAIAccounts);
  const defaultAccountProfileId = useStore((state) => state.lastOpenAIAccountProfileId);
  const catalogs = useStore((state) => state.openAIModelCatalogs);
  const fallbackModels = useStore((state) => state.openAIModels);
  const pinSessionOpenAIAccount = useStore((state) => state.pinSessionOpenAIAccount);
  const newSession = useStore((state) => state.newSession);
  const streaming = useStore((state) => state.streaming);
  const connected = useMemo(
    () => accounts.filter((account) => account.state === "connected"),
    [accounts],
  );
  const defaultAccount = preferredOpenAIAccount(connected, defaultAccountProfileId);
  const selectedValue = session.accountProfileId ?? defaultAccount?.id ?? "";
  const currentAccount = accounts.find((account) => account.id === session.accountProfileId);
  const [switching, setSwitching] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [pendingAccountProfileId, setPendingAccountProfileId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const currentAccountUnavailable = Boolean(
    session.accountProfileId &&
    !connected.some((account) => account.id === session.accountProfileId),
  );

  if (
    connected.length === 0 ||
    (!currentAccountUnavailable && connected.length < 2) ||
    !selectedValue
  ) {
    return null;
  }

  const connectedOptions = connected.map((account) => ({
    value: account.id,
    label: openAIAccountLabel(account, accounts),
  }));
  const groups: SelectMenuGroup[] = [];
  if (session.accountProfileId && currentAccountUnavailable) {
    groups.push({
      id: "current-unavailable-account",
      label: "Current account",
      options: [
        {
          value: session.accountProfileId,
          label: currentAccount
            ? `${openAIAccountLabel(currentAccount, accounts)} · unavailable`
            : "Current ChatGPT account · unavailable",
          disabled: true,
        },
      ],
    });
  }
  groups.push({
    id: "connected-chatgpt-accounts",
    label: "ChatGPT accounts",
    options: connectedOptions,
  });

  const pendingAccount = pendingAccountProfileId
    ? connected.find((account) => account.id === pendingAccountProfileId)
    : undefined;
  const currentLabel = currentAccount
    ? openAIAccountLabel(currentAccount, accounts)
    : "the current ChatGPT account";
  const nextLabel = pendingAccount
    ? openAIAccountLabel(pendingAccount, accounts)
    : "the selected ChatGPT account";

  const selectAccount = async (accountProfileId: string) => {
    if (switching || continuing || accountProfileId === session.accountProfileId) return;
    setSwitchError(null);
    setSwitching(true);
    try {
      const result = await pinSessionOpenAIAccount(session.id, accountProfileId);
      if (result === "locked") {
        useStore.setState({ openAIAuthError: null });
        setPendingAccountProfileId(accountProfileId);
      } else if (result === "error") {
        setSwitchError(
          useStore.getState().openAIAuthError ?? "The ChatGPT account could not be changed.",
        );
      }
    } finally {
      setSwitching(false);
    }
  };

  const continueInNewChat = async () => {
    if (!pendingAccountProfileId || continuing) return;
    const models = modelsForOpenAIProfile(pendingAccountProfileId, catalogs, fallbackModels);
    const model = models.find((candidate) => candidate.id === session.model) ?? models[0];
    if (!model) {
      setSwitchError("No compatible GPT model is available for the selected account.");
      return;
    }
    const previousActiveId = useStore.getState().activeId;
    setContinuing(true);
    try {
      await newSession(pendingAccountProfileId, model.id);
      if (useStore.getState().activeId !== previousActiveId) {
        setPendingAccountProfileId(null);
        setSwitchError(null);
      } else {
        setSwitchError(
          useStore.getState().openAIAuthError ??
            "A new chat could not be created for this account.",
        );
      }
    } finally {
      setContinuing(false);
    }
  };

  return (
    <>
      <div className="pc-session-account-switcher flex min-w-0 items-center gap-2">
        <SelectMenu
          value={selectedValue}
          label="ChatGPT account for this chat"
          title="Switch the ChatGPT account for this chat before its first message"
          onChange={(next) => void selectAccount(next)}
          disabled={switching || continuing || streaming}
          placement="top"
          className="pc-session-account-switcher__select"
          buttonClassName="pc-composer-account-trigger"
          groups={groups}
        />
        {switchError && !pendingAccountProfileId && (
          <span
            role="alert"
            title={switchError}
            className="max-w-32 truncate font-mono text-[9px] text-danger"
          >
            Couldn’t switch account
          </span>
        )}
      </div>
      {pendingAccountProfileId && (
        <SessionActionDialog
          state={{
            kind: "accountSwitch",
            session,
            currentAccountLabel: currentLabel,
            nextAccountLabel: nextLabel,
            message: switchError ?? undefined,
          }}
          busy={continuing}
          onCancel={() => {
            useStore.setState({ openAIAuthError: null });
            setSwitchError(null);
            setPendingAccountProfileId(null);
          }}
          onConfirm={() => void continueInNewChat()}
        />
      )}
    </>
  );
}
