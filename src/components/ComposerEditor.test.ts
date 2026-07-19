import { describe, expect, it, vi } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  createEditor,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from "lexical";
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
  registerList,
  registerListStrictIndentTransform,
  type ListType,
} from "@lexical/list";
import { registerMarkdownShortcuts, $convertToMarkdownString } from "@lexical/markdown";
import { HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
import { $findMatchingParent } from "@lexical/utils";

import {
  $importComposerMarkdown,
  $normalizeComposerImportedLists,
  COMPOSER_TRANSFORMERS,
  registerComposerEnterCommand,
  registerComposerTabCommand,
} from "./ComposerEditor";

const update = (editor: LexicalEditor, fn: () => void) =>
  new Promise<void>((resolve) => editor.update(fn, { onUpdate: resolve }));

const createComposerEditor = () =>
  createEditor({
    namespace: `ComposerEditorTest-${Math.random()}`,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
    onError(error) {
      throw error;
    },
  });

const seedMarker = async (editor: LexicalEditor, marker: string) => {
  await update(editor, () => {
    const paragraph = $createParagraphNode();
    const text = $createTextNode(marker);
    paragraph.append(text);
    $getRoot().clear().append(paragraph);
    text.selectEnd();
  });
  await update(editor, () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
    selection.insertText(" ");
  });
};

const typeText = (editor: LexicalEditor, value: string) =>
  update(editor, () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
    selection.insertText(value);
  });

const markdown = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => $convertToMarkdownString(COMPOSER_TRANSFORMERS));

const importMarkdown = (editor: LexicalEditor, value: string) =>
  update(editor, () => $importComposerMarkdown(value));

const selectText = (
  editor: LexicalEditor,
  anchorText: string,
  anchorOffset: number,
  focusText = anchorText,
  focusOffset = anchorOffset,
) =>
  update(editor, () => {
    const texts = $getRoot().getAllTextNodes();
    const anchor = texts.find((node) => node.getTextContent() === anchorText);
    const focus = texts.find((node) => node.getTextContent() === focusText);
    if (!anchor || !focus) throw new Error("Expected list item text nodes");
    anchor.select(anchorOffset, anchorOffset);
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
    selection.focus.set(focus.getKey(), focusOffset, "text");
  });

const dispatchTab = async (
  editor: LexicalEditor,
  init: KeyboardEventInit = {},
  composing = false,
) => {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    cancelable: true,
    ...init,
  });
  if (composing) Object.defineProperty(event, "isComposing", { value: true });
  let handled = false;
  await update(editor, () => {
    handled = editor.dispatchCommand(KEY_TAB_COMMAND, event);
  });
  return { event, handled };
};

const dispatchEnter = async (editor: LexicalEditor, shiftKey = false) => {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey,
    cancelable: true,
  });
  let handled = false;
  await update(editor, () => {
    handled = editor.dispatchCommand(KEY_ENTER_COMMAND, event);
  });
  return { event, handled };
};

const registerComposerListBehavior = (editor: LexicalEditor, onSubmit = vi.fn()) => {
  const cleanups = [
    registerRichText(editor),
    registerList(editor, { restoreNumbering: true }),
    registerListStrictIndentTransform(editor),
    registerComposerEnterCommand(editor, onSubmit),
    registerComposerTabCommand(editor),
  ];
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
};

const selectedListItemState = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    const anchor = selection.anchor.getNode();
    const item = $isListItemNode(anchor) ? anchor : $findMatchingParent(anchor, $isListItemNode);
    return item
      ? { checked: item.getChecked(), depth: item.getIndent(), text: item.getTextContent() }
      : null;
  });

describe("ComposerEditor Markdown shortcuts", () => {
  it("turns '- ' into a rendered bullet immediately and keeps Markdown storage", async () => {
    const editor = createComposerEditor();
    const unregister = registerMarkdownShortcuts(editor, COMPOSER_TRANSFORMERS);
    try {
      await seedMarker(editor, "-");
      await typeText(editor, "first item");

      editor.getEditorState().read(() => {
        const list = $getRoot().getFirstChild();
        expect($isListNode(list)).toBe(true);
        if ($isListNode(list)) expect(list.getListType()).toBe("bullet");
      });
      expect(markdown(editor)).toBe("- first item");
    } finally {
      unregister();
    }
  });

  it("turns '- [ ] ' into an interactive task item", async () => {
    const editor = createComposerEditor();
    const unregister = registerMarkdownShortcuts(editor, COMPOSER_TRANSFORMERS);
    try {
      await seedMarker(editor, "- [ ]");
      await typeText(editor, "ship it");

      editor.getEditorState().read(() => {
        const list = $getRoot().getFirstChild();
        expect($isListNode(list)).toBe(true);
        if ($isListNode(list)) expect(list.getListType()).toBe("check");
      });
      expect(markdown(editor)).toBe("- [ ] ship it");
    } finally {
      unregister();
    }
  });

  it.each([
    ["*", "bullet", "* item"],
    ["+", "bullet", "+ item"],
    ["3.", "number", "3. item"],
    ["- [x]", "check", "- [x] item"],
  ] as const)(
    "formats the %s marker only after its trailing space",
    async (marker, type, output) => {
      const editor = createComposerEditor();
      const unregister = registerMarkdownShortcuts(editor, COMPOSER_TRANSFORMERS);
      try {
        await seedMarker(editor, marker);
        await typeText(editor, "item");

        editor.getEditorState().read(() => {
          const list = $getRoot().getFirstChild();
          expect($isListNode(list) && list.getListType()).toBe(type);
        });
        expect(markdown(editor)).toBe(output);
      } finally {
        unregister();
      }
    },
  );

  it("does not transform a list marker typed in the middle of prose", async () => {
    const editor = createComposerEditor();
    const unregister = registerMarkdownShortcuts(editor, COMPOSER_TRANSFORMERS);
    try {
      await update(editor, () => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode("before -");
        paragraph.append(text);
        $getRoot().clear().append(paragraph);
        text.selectEnd();
      });
      await typeText(editor, " ");

      editor.getEditorState().read(() => {
        expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
      });
      expect(markdown(editor)).toBe("before - ");
    } finally {
      unregister();
    }
  });
});

describe("ComposerEditor list indentation", () => {
  it.each([0, 2, 5])("nests and outdents a bullet with the caret at offset %i", async (offset) => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "- parent\n- child");
      await selectText(editor, "child", offset);

      const indent = await dispatchTab(editor);
      expect(indent.handled).toBe(true);
      expect(indent.event.defaultPrevented).toBe(true);
      expect(markdown(editor)).toBe("- parent\n    - child");

      const outdent = await dispatchTab(editor, { shiftKey: true });
      expect(outdent.handled).toBe(true);
      expect(outdent.event.defaultPrevented).toBe(true);
      expect(markdown(editor)).toBe("- parent\n- child");
    } finally {
      unregister();
    }
  });

  it("restarts a newly nested ordered list at one and restores its outer sequence", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "3. parent\n4. child");
      await selectText(editor, "child", 5);

      expect((await dispatchTab(editor)).handled).toBe(true);
      expect(markdown(editor)).toBe("3. parent\n    1. child");

      expect((await dispatchTab(editor, { shiftKey: true })).handled).toBe(true);
      expect(markdown(editor)).toBe("3. parent\n4. child");
    } finally {
      unregister();
    }
  });

  it("preserves checked state while nesting and outdenting tasks", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "- [ ] parent\n- [x] child");
      await selectText(editor, "child", 5);

      expect((await dispatchTab(editor)).handled).toBe(true);
      expect(markdown(editor)).toBe("- [ ] parent\n    - [x] child");

      expect((await dispatchTab(editor, { shiftKey: true })).handled).toBe(true);
      expect(markdown(editor)).toBe("- [ ] parent\n- [x] child");
    } finally {
      unregister();
    }
  });

  it("indents a contiguous multi-item selection atomically", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "- parent\n- alpha\n- beta\n- after");
      await selectText(editor, "alpha", 0, "beta", 4);

      expect((await dispatchTab(editor)).handled).toBe(true);
      expect(markdown(editor)).toBe("- parent\n    - alpha\n    - beta\n- after");

      expect((await dispatchTab(editor, { shiftKey: true })).handled).toBe(true);
      expect(markdown(editor)).toBe("- parent\n- alpha\n- beta\n- after");
    } finally {
      unregister();
    }
  });

  it("moves an item's existing nested subtree without changing relative depth", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "- parent\n- child\n    - grandchild\n- after");
      await selectText(editor, "child", 2, "after", 5);

      expect((await dispatchTab(editor)).handled).toBe(true);
      expect(markdown(editor)).toBe("- parent\n    - child\n        - grandchild\n    - after");
    } finally {
      unregister();
    }
  });

  it("leaves structurally impossible Tab operations unhandled", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "- first\n- second");
      await selectText(editor, "first", 0);
      const firstItem = await dispatchTab(editor);
      expect(firstItem.handled).toBe(false);
      expect(firstItem.event.defaultPrevented).toBe(false);
      expect(markdown(editor)).toBe("- first\n- second");

      await selectText(editor, "second", 0);
      const topLevelOutdent = await dispatchTab(editor, { shiftKey: true });
      expect(topLevelOutdent.handled).toBe(false);
      expect(topLevelOutdent.event.defaultPrevented).toBe(false);
      expect(markdown(editor)).toBe("- first\n- second");
    } finally {
      unregister();
    }
  });

  it("does not handle Tab outside lists, across separate lists, with modifiers, or during IME", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "plain paragraph");
      await selectText(editor, "plain paragraph", 5);
      expect((await dispatchTab(editor)).handled).toBe(false);

      await importMarkdown(editor, "- first\n\nbetween\n\n- second");
      await selectText(editor, "first", 0, "second", 6);
      expect((await dispatchTab(editor)).handled).toBe(false);
      expect(markdown(editor)).toBe("- first\n\nbetween\n\n- second");

      await selectText(editor, "second", 2);
      expect((await dispatchTab(editor, { ctrlKey: true })).handled).toBe(false);
      expect((await dispatchTab(editor, { altKey: true })).handled).toBe(false);
      expect((await dispatchTab(editor, { metaKey: true })).handled).toBe(false);
      expect((await dispatchTab(editor, {}, true)).handled).toBe(false);
    } finally {
      unregister();
    }
  });

  it("rejects a selection crossing from a nested branch to its following top-level item", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    const source = "- parent\n    - nested\n- after";
    try {
      await importMarkdown(editor, source);
      await selectText(editor, "nested", 0, "after", 5);

      const result = await dispatchTab(editor);
      expect(result.handled).toBe(false);
      expect(result.event.defaultPrevented).toBe(false);
      expect(markdown(editor)).toBe(source);
    } finally {
      unregister();
    }
  });

  it("recognizes descendants behind multiple mixed-type wrapper lists", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    const source = "- parent\n    1. numbered\n    - bullet";
    try {
      await importMarkdown(editor, source);
      await selectText(editor, "parent", 0, "bullet", 6);

      const result = await dispatchTab(editor);
      expect(result.handled).toBe(false);
      expect(result.event.defaultPrevented).toBe(false);
      expect(markdown(editor)).toBe(source);
    } finally {
      unregister();
    }
  });

  it("enforces six visible levels without flattening imported deeper Markdown", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    const source = [
      "- zero",
      "    - one",
      "        - two",
      "            - three",
      "                - four",
      "                    - five-a",
      "                    - five-b",
    ].join("\n");
    try {
      await importMarkdown(editor, source);
      await selectText(editor, "five-b", 6);
      const result = await dispatchTab(editor);
      expect(result.handled).toBe(false);
      expect(result.event.defaultPrevented).toBe(false);
      expect(markdown(editor)).toBe(source);

      const deeper = `${source}\n                        - imported-six`;
      await importMarkdown(editor, deeper);
      expect(markdown(editor)).toBe(deeper);
    } finally {
      unregister();
    }
  });
});

describe("ComposerEditor Markdown import normalization", () => {
  it("round-trips mixed nested list types at multiple depths", async () => {
    const editor = createComposerEditor();
    const source = "- parent\n    1. child\n        - grandchild";
    await importMarkdown(editor, source);
    expect(markdown(editor)).toBe(source);
  });

  it("keeps blank-line-separated lists independent", async () => {
    const editor = createComposerEditor();
    const source = "- bullet\n\n1. separate";
    await importMarkdown(editor, source);
    expect(markdown(editor)).toBe(source);
    editor.getEditorState().read(() => {
      const lists = $getRoot().getChildren().filter($isListNode);
      expect(lists.map((list) => list.getListType())).toEqual(["bullet", "number"]);
    });
  });

  it("merges an orphan carrier into an existing nested list of the same type", async () => {
    const editor = createComposerEditor();
    await update(editor, () => {
      const rootList = $createListNode("bullet");
      const parent = $createListItemNode().append($createTextNode("parent"));
      const existingWrapper = $createListItemNode();
      const existingList = $createListNode("number");
      existingList.append($createListItemNode().append($createTextNode("existing")));
      existingWrapper.append(existingList);
      rootList.append(parent, existingWrapper);

      const carrier = $createListNode("number");
      const attachment = $createListItemNode();
      const incomingList = $createListNode("number");
      incomingList.append($createListItemNode().append($createTextNode("incoming")));
      attachment.append(incomingList);
      carrier.append(attachment);
      $getRoot().clear().append(rootList, carrier);

      $normalizeComposerImportedLists();
    });

    expect(markdown(editor)).toBe("- parent\n    1. existing\n    2. incoming");
    editor.getEditorState().read(() => {
      expect($getRoot().getChildrenSize()).toBe(1);
    });
  });
});

describe("ComposerEditor list keyboard flow", () => {
  it("continues, outdents, and exits a nested list on successive Shift+Enter presses", async () => {
    const editor = createComposerEditor();
    const onSubmit = vi.fn();
    const unregister = registerComposerListBehavior(editor, onSubmit);
    try {
      await importMarkdown(editor, "- parent\n    - child");
      await selectText(editor, "child", 5);

      const continued = await dispatchEnter(editor, true);
      expect(continued.handled).toBe(true);
      expect(selectedListItemState(editor)).toEqual({ checked: undefined, depth: 1, text: "" });

      const outdented = await dispatchEnter(editor, true);
      expect(outdented.handled).toBe(true);
      expect(selectedListItemState(editor)).toEqual({ checked: undefined, depth: 0, text: "" });

      const exited = await dispatchEnter(editor, true);
      expect(exited.handled).toBe(true);
      expect(selectedListItemState(editor)).toBeNull();
      editor.getEditorState().read(() => {
        expect($isParagraphNode($getRoot().getLastChild())).toBe(true);
      });
      expect(markdown(editor)).toBe("- parent\n    - child\n");
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("creates an unchecked task after a checked task", async () => {
    const editor = createComposerEditor();
    const unregister = registerComposerListBehavior(editor);
    try {
      await importMarkdown(editor, "- [x] completed");
      await selectText(editor, "completed", 9);

      expect((await dispatchEnter(editor, true)).handled).toBe(true);
      expect(selectedListItemState(editor)).toEqual({ checked: false, depth: 0, text: "" });
    } finally {
      unregister();
    }
  });

  it.each([
    ["bullet", "bulleted"],
    ["number", "numbered"],
  ] as const)(
    "uses Shift+Enter to continue and then exit a %s list",
    async (listType: ListType, _label) => {
      const editor = createComposerEditor();
      const onSubmit = vi.fn();
      const unregisterRichText = registerRichText(editor);
      const unregisterList = registerList(editor);
      const unregisterEnter = registerComposerEnterCommand(editor, onSubmit);

      try {
        await update(editor, () => {
          const list = $createListNode(listType);
          const item = $createListItemNode();
          const text = $createTextNode("first item");
          item.append(text);
          list.append(item);
          $getRoot().clear().append(list);
          text.selectEnd();
        });

        const firstShiftEnter = new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          cancelable: true,
        });
        await update(editor, () => {
          expect(editor.dispatchCommand(KEY_ENTER_COMMAND, firstShiftEnter)).toBe(true);
        });

        editor.getEditorState().read(() => {
          const list = $getRoot().getFirstChild();
          expect($isListNode(list)).toBe(true);
          if ($isListNode(list)) {
            expect(list.getListType()).toBe(listType);
            expect(list.getChildrenSize()).toBe(2);
            expect(list.getLastChild()?.getTextContent()).toBe("");
          }
        });
        expect(firstShiftEnter.defaultPrevented).toBe(true);
        expect(onSubmit).not.toHaveBeenCalled();

        const secondShiftEnter = new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          cancelable: true,
        });
        await update(editor, () => {
          expect(editor.dispatchCommand(KEY_ENTER_COMMAND, secondShiftEnter)).toBe(true);
        });

        editor.getEditorState().read(() => {
          const root = $getRoot();
          const list = root.getFirstChild();
          expect($isListNode(list)).toBe(true);
          if ($isListNode(list)) {
            expect(list.getListType()).toBe(listType);
            expect(list.getChildrenSize()).toBe(1);
          }
          expect($isParagraphNode(root.getLastChild())).toBe(true);
        });
        expect(secondShiftEnter.defaultPrevented).toBe(true);
        expect(onSubmit).not.toHaveBeenCalled();
      } finally {
        unregisterEnter();
        unregisterList();
        unregisterRichText();
      }
    },
  );

  it("formats a numbered list after exiting a bullet list", async () => {
    const editor = createComposerEditor();
    const onSubmit = vi.fn();
    const unregisterRichText = registerRichText(editor);
    const unregisterList = registerList(editor);
    const unregisterMarkdown = registerMarkdownShortcuts(editor, COMPOSER_TRANSFORMERS);
    const unregisterEnter = registerComposerEnterCommand(editor, onSubmit);

    try {
      await seedMarker(editor, "-");
      await typeText(editor, "bullet item");

      for (let index = 0; index < 2; index += 1) {
        const shiftEnter = new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          cancelable: true,
        });
        await update(editor, () => {
          expect(editor.dispatchCommand(KEY_ENTER_COMMAND, shiftEnter)).toBe(true);
        });
      }

      await typeText(editor, "1");
      await typeText(editor, ".");
      await typeText(editor, " ");
      await typeText(editor, "numbered item");

      editor.getEditorState().read(() => {
        const lists = $getRoot().getChildren().filter($isListNode);
        expect(lists.map((list) => list.getListType())).toEqual(["bullet", "number"]);
      });
      expect(markdown(editor)).toBe("- bullet item\n\n1. numbered item");
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      unregisterEnter();
      unregisterMarkdown();
      unregisterList();
      unregisterRichText();
    }
  });

  it("formats a new list after blank lines because Shift+Enter creates blocks", async () => {
    const editor = createComposerEditor();
    const onSubmit = vi.fn();
    const unregisterRichText = registerRichText(editor);
    const unregisterList = registerList(editor);
    const unregisterMarkdown = registerMarkdownShortcuts(editor, COMPOSER_TRANSFORMERS);
    const unregisterEnter = registerComposerEnterCommand(editor, onSubmit);

    try {
      await seedMarker(editor, "-");
      await typeText(editor, "bullet item");

      // Continue the bullet, exit its empty item, then leave a blank block.
      for (let index = 0; index < 3; index += 1) {
        const shiftEnter = new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          cancelable: true,
        });
        await update(editor, () => {
          expect(editor.dispatchCommand(KEY_ENTER_COMMAND, shiftEnter)).toBe(true);
        });
      }

      await typeText(editor, "1");
      await typeText(editor, ".");
      await typeText(editor, " ");
      await typeText(editor, "numbered item");

      editor.getEditorState().read(() => {
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(3);
        expect($isListNode(children[0]) && children[0].getListType()).toBe("bullet");
        expect($isParagraphNode(children[1])).toBe(true);
        expect($isListNode(children[2]) && children[2].getListType()).toBe("number");
      });
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      unregisterEnter();
      unregisterMarkdown();
      unregisterList();
      unregisterRichText();
    }
  });
});
