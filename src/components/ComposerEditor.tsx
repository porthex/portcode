import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  INDENT_CONTENT_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  type LexicalNode,
  type LexicalEditor,
} from "lexical";
import { $findMatchingParent } from "@lexical/utils";
import { ListItemNode, ListNode, $isListItemNode, $isListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_STAR,
  CHECK_LIST,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type Transformer,
} from "@lexical/markdown";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";

export const COMPOSER_TRANSFORMERS: Transformer[] = [
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  QUOTE,
  HEADING,
  BOLD_ITALIC_STAR,
  BOLD_STAR,
  ITALIC_STAR,
  STRIKETHROUGH,
  INLINE_CODE,
];

const EXTERNAL_DRAFT_TAG = "portcode-external-draft";

/** Top-level plus five nested levels keeps technical prompts useful and compact. */
export const MAX_LIST_LEVELS = 6;

const theme = {
  heading: {
    h1: "pc-composer-editor__h1",
    h2: "pc-composer-editor__h2",
    h3: "pc-composer-editor__h3",
  },
  list: {
    checklist: "pc-composer-editor__checklist",
    listitem: "pc-composer-editor__listitem",
    listitemChecked: "pc-composer-editor__listitem--checked",
    listitemUnchecked: "pc-composer-editor__listitem--unchecked",
    nested: { listitem: "pc-composer-editor__listitem--nested" },
    ol: "pc-composer-editor__ol",
    ul: "pc-composer-editor__ul",
  },
  paragraph: "pc-composer-editor__paragraph",
  quote: "pc-composer-editor__quote",
  text: {
    bold: "pc-composer-editor__bold",
    code: "pc-composer-editor__code",
    italic: "pc-composer-editor__italic",
    strikethrough: "pc-composer-editor__strikethrough",
  },
};

type ComposerEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
  editableRef: RefObject<HTMLDivElement | null>;
  maxHeight: number;
};

function $nestedListFromWrapper(node: LexicalNode | null): ListNode | null {
  if (!$isListItemNode(node) || node.getChildrenSize() !== 1) return null;
  const child = node.getFirstChild();
  return $isListNode(child) ? child : null;
}

function $isNestedListWrapper(node: LexicalNode | null): boolean {
  return $nestedListFromWrapper(node) !== null;
}

function $nearestListItem(node: LexicalNode): ListItemNode | null {
  return $isListItemNode(node) ? node : $findMatchingParent(node, $isListItemNode);
}

function $topListForItem(item: ListItemNode): ListNode | null {
  const parent = item.getParent();
  if (!$isListNode(parent)) return null;
  let list: ListNode = parent;

  while (true) {
    const wrapper: LexicalNode | null = list.getParent();
    if (!$isNestedListWrapper(wrapper)) return list;
    const outerList: LexicalNode | null = wrapper?.getParent() ?? null;
    if (!$isListNode(outerList)) return list;
    list = outerList;
  }
}

/** Return the content item that semantically owns an item's nested list. */
function $semanticParentItem(item: ListItemNode): ListItemNode | null {
  const list = item.getParent();
  if (!$isListNode(list)) return null;
  const wrapper = list.getParent();
  if (!$isListItemNode(wrapper) || !$isNestedListWrapper(wrapper)) return null;

  let previous = wrapper.getPreviousSibling();
  while ($isListItemNode(previous) && $isNestedListWrapper(previous)) {
    previous = previous.getPreviousSibling();
  }
  return $isListItemNode(previous) ? previous : null;
}

function $isSemanticDescendantOf(item: ListItemNode, ancestor: ListItemNode): boolean {
  let parent = $semanticParentItem(item);
  while (parent) {
    if (parent.is(ancestor)) return true;
    parent = $semanticParentItem(parent);
  }
  return false;
}

function $contentItems(list: ListNode): ListItemNode[] {
  return list
    .getChildren()
    .filter((node): node is ListItemNode => $isListItemNode(node) && !$isNestedListWrapper(node));
}

function $collectListItems(node: LexicalNode, output: ListItemNode[]): void {
  if ($isListNode(node)) {
    for (const child of node.getChildren()) $collectListItems(child, output);
    return;
  }
  if (!$isListItemNode(node)) return;
  const nested = $nestedListFromWrapper(node);
  if (nested) {
    $collectListItems(nested, output);
    return;
  }
  output.push(node);
}

function $deepestSemanticDepth(item: ListItemNode): number {
  let deepest = item.getIndent();
  let sibling = item.getNextSibling();
  while ($isListItemNode(sibling) && $isNestedListWrapper(sibling)) {
    const nested = $nestedListFromWrapper(sibling);
    if (nested) {
      const descendants: ListItemNode[] = [];
      $collectListItems(nested, descendants);
      for (const descendant of descendants) deepest = Math.max(deepest, descendant.getIndent());
    }
    sibling = sibling.getNextSibling();
  }
  return deepest;
}

type ListSelection = {
  items: ListItemNode[];
  list: ListNode;
};

/**
 * Collapse a range to the shallowest selected sibling items. Nested descendants
 * move with their owner, so dispatching the native command keeps the subtree's
 * relative structure intact.
 */
function $selectedSiblingItems(): ListSelection | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;

  const anchorItem = $nearestListItem(selection.anchor.getNode());
  const focusItem = $nearestListItem(selection.focus.getNode());
  if (!anchorItem || !focusItem) return null;

  const topList = $topListForItem(anchorItem);
  if (!topList || !$topListForItem(focusItem)?.is(topList)) return null;

  const selected = new Map<string, ListItemNode>();
  for (const node of selection.getNodes()) {
    const item = $nearestListItem(node);
    if (item && !$isNestedListWrapper(item)) selected.set(item.getKey(), item);
  }
  selected.set(anchorItem.getKey(), anchorItem);
  selected.set(focusItem.getKey(), focusItem);

  const allItems = [...selected.values()];
  const shallowestDepth = Math.min(...allItems.map((item) => item.getIndent()));
  const roots = allItems.filter((item) => item.getIndent() === shallowestDepth);
  if (
    allItems.some(
      (item) => !roots.some((root) => item.is(root) || $isSemanticDescendantOf(item, root)),
    )
  ) {
    return null;
  }

  const parent = roots[0]?.getParent();
  if (!$isListNode(parent) || roots.some((item) => !item.getParent()?.is(parent))) return null;

  const siblings = $contentItems(parent);
  const rootKeys = new Set(roots.map((item) => item.getKey()));
  const ordered = siblings.filter((item) => rootKeys.has(item.getKey()));
  if (ordered.length !== roots.length) return null;
  const firstIndex = siblings.findIndex((item) => item.is(ordered[0]));
  if (firstIndex < 0 || ordered.some((item, index) => !item.is(siblings[firstIndex + index]))) {
    return null;
  }

  return { items: ordered, list: parent };
}

/**
 * Lexical 0.48 imports mixed-marker nested Markdown as a root-level carrier
 * list containing wrapper items. Reattach only that unmistakable shape to the
 * preceding item at the encoded depth; ordinary adjacent lists stay separate.
 */
export function $normalizeComposerImportedLists(): void {
  const root = $getRoot();
  for (const node of [...root.getChildren()]) {
    if (!$isListNode(node)) continue;

    let carrierList = node;
    let attachment: ListItemNode | null = null;
    while (carrierList.getChildrenSize() === 1) {
      const wrapper = carrierList.getFirstChild();
      const nested = $nestedListFromWrapper(wrapper);
      if (!nested || !$isListItemNode(wrapper)) break;
      attachment = wrapper;
      carrierList = nested;
    }
    if (!attachment) continue;

    const firstContent = $contentItems(carrierList)[0];
    if (!firstContent || firstContent.getIndent() <= 0) continue;
    const targetDepth = firstContent.getIndent() - 1;
    const precedingItems: ListItemNode[] = [];
    for (const sibling of node.getPreviousSiblings()) $collectListItems(sibling, precedingItems);
    let target: ListItemNode | undefined;
    for (let index = precedingItems.length - 1; index >= 0; index -= 1) {
      if (precedingItems[index].getIndent() === targetDepth) {
        target = precedingItems[index];
        break;
      }
    }
    if (!target) continue;

    const incoming = $nestedListFromWrapper(attachment);
    if (!incoming) continue;
    let insertionPoint: LexicalNode = target;
    let next = target.getNextSibling();
    while ($isListItemNode(next) && $isNestedListWrapper(next)) {
      insertionPoint = next;
      next = next.getNextSibling();
    }

    const existing = $nestedListFromWrapper(insertionPoint);
    if (existing && existing.getListType() === incoming.getListType()) {
      existing.append(...incoming.getChildren());
    } else {
      insertionPoint.insertAfter(attachment);
    }
    node.remove();
  }
}

export function $importComposerMarkdown(value: string): void {
  $convertFromMarkdownString(value, COMPOSER_TRANSFORMERS);
  $normalizeComposerImportedLists();
}

function EditablePlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  return null;
}

function ExternalDraftPlugin({
  value,
  lastEmittedValue,
}: {
  value: string;
  lastEmittedValue: MutableRefObject<string>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (value === lastEmittedValue.current) return;
    lastEmittedValue.current = value;
    editor.update(
      () => {
        $importComposerMarkdown(value);
      },
      { tag: EXTERNAL_DRAFT_TAG },
    );
  }, [editor, lastEmittedValue, value]);

  return null;
}

export function registerComposerEnterCommand(editor: LexicalEditor, onSubmit: () => void) {
  return editor.registerCommand(
    KEY_ENTER_COMMAND,
    (event) => {
      if (!event || event.isComposing) return false;
      const selection = $getSelection();
      const item = $isRangeSelection(selection)
        ? $findMatchingParent(selection.anchor.getNode(), $isListItemNode)
        : null;

      if (event.shiftKey) {
        // A composer "new line" is a real block, not a soft <br>. That lets
        // Lexical's official Markdown shortcuts recognize a fresh `- `, `1. `,
        // quote, task, or heading after any number of blank lines. Inside lists,
        // the same command continues a non-empty item and exits an empty one.
        event.preventDefault();
        return editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      }

      // Plain Enter keeps Lexical's native continue/exit behavior while the
      // selection is in a list; outside structured content it submits the turn.
      if (item) return false;
      event.preventDefault();
      onSubmit();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

export function registerComposerTabCommand(editor: LexicalEditor) {
  return editor.registerCommand(
    KEY_TAB_COMMAND,
    (event) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;

      const selected = $selectedSiblingItems();
      if (!selected) return false;

      if (event.shiftKey) {
        if (selected.items.some((item) => item.getIndent() === 0)) return false;
      } else {
        const first = selected.items[0];
        if (!first.getPreviousSibling()) return false;
        if (selected.items.some((item) => $deepestSemanticDepth(item) + 1 >= MAX_LIST_LEVELS)) {
          return false;
        }
      }

      const first = selected.items[0];
      const targetAlreadyExists =
        !event.shiftKey && $isNestedListWrapper(first.getPreviousSibling());
      const handled = editor.dispatchCommand(
        event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND,
        undefined,
      );
      if (!handled) return false;

      // ListItemNode#setIndent copies its source ListNode, including an ordered
      // list's non-1 start. Only a newly-created nested list should restart.
      if (!event.shiftKey && !targetAlreadyExists) {
        const nested = first.getParent();
        if ($isListNode(nested) && nested.getListType() === "number") nested.setStart(1);
      }

      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

function SubmitPlugin({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerComposerEnterCommand(editor, onSubmit), [editor, onSubmit]);
  return null;
}

function ListKeyboardPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerComposerTabCommand(editor), [editor]);
  return null;
}

function GrowPlugin({
  editableRef,
  maxHeight,
}: Pick<ComposerEditorProps, "editableRef" | "maxHeight">) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerUpdateListener(() => {
        const element = editableRef.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
      }),
    [editableRef, editor, maxHeight],
  );
  return null;
}

export function ComposerEditor({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  editableRef,
  maxHeight,
}: ComposerEditorProps) {
  const lastEmittedValue = useRef(value);

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "PortcodeComposer",
        editable: !disabled,
        editorState: () => $importComposerMarkdown(value),
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
        onError(error) {
          throw error;
        },
        theme,
      }}
    >
      <div className="pc-composer-editor-shell">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              ref={editableRef}
              aria-describedby="pc-composer-status"
              aria-label="Message Portcode"
              aria-placeholder={placeholder}
              className="pc-composer-editor"
              placeholder={<div className="pc-composer-editor__placeholder">{placeholder}</div>}
              style={{ maxHeight: `min(${maxHeight}px, 30dvh)` }}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ListPlugin hasStrictIndent shouldPreserveNumbering />
      <CheckListPlugin />
      <MarkdownShortcutPlugin transformers={COMPOSER_TRANSFORMERS} />
      <OnChangePlugin
        ignoreHistoryMergeTagChange
        onChange={(editorState, _editor, tags) => {
          if (tags.has(EXTERNAL_DRAFT_TAG)) return;
          editorState.read(() => {
            const markdown = $convertToMarkdownString(COMPOSER_TRANSFORMERS);
            lastEmittedValue.current = markdown;
            onChange(markdown);
          });
        }}
      />
      <EditablePlugin disabled={disabled} />
      <ExternalDraftPlugin value={value} lastEmittedValue={lastEmittedValue} />
      <SubmitPlugin onSubmit={onSubmit} />
      <ListKeyboardPlugin />
      <GrowPlugin editableRef={editableRef} maxHeight={maxHeight} />
    </LexicalComposer>
  );
}
