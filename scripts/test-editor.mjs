import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Enter through the mounted app and observe rendered text and keyboard editing.
// This sequence reproduced a rendering crash on @codemirror/view 6.43.4.
const edits = [
  { from: 13, to: 15, insert: '[]' },
  { from: 18, to: 20, insert: '- ' },
  { from: 3, to: 5, insert: '\n' },
  { from: 16, to: 16, insert: 'x' },
  { from: 9, to: 10, insert: '[ ]' },
  { from: 4, to: 6, insert: '' },
  { from: 15, to: 16, insert: ' ' },
  { from: 12, to: 12, insert: '*' },
  { from: 6, to: 8, insert: '[]' },
];
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { force: true },
});
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}`;
try {
  for (const [name, engine] of Object.entries({ webkit, chromium })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.locator('.cm-content').waitFor();
      await page.evaluate(async edits => {
        const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
        const view = EditorView.findFromDOM(document.querySelector('.cm-content'));
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '- [ ] a\n- [x] b\n- [ ] c' } });
        for (const edit of edits) {
          view.dispatch({ changes: edit, selection: { anchor: edit.from + edit.insert.length } });
        }
      }, edits);
      await page.getByRole('button', { name: 'New note', exact: true }).click();
      assert.equal((await page.locator('.cm-content').innerText()).trim(), 'Start typing…', `${name}: new note must remove all old visible text`);
      assert.equal(await page.locator('.cm-task-checkbox').count(), 0);
      await page.locator('.cm-content').click();
      await page.keyboard.insertText('Editable after clearing');
      assert.equal((await page.locator('.cm-content').innerText()).trim(), 'Editable after clearing');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      await page.keyboard.press('Backspace');
      assert.equal((await page.locator('.cm-content').innerText()).trim(), 'Start typing…', `${name}: select-all and deletion must work`);

      // Growing hidden heading markers in one transaction previously duplicated
      // replacement DOM and lost a line in CodeMirror versions before 6.43.7.
      await page.evaluate(async () => {
        const { EditorView } = await import('/node_modules/@codemirror/view/dist/index.js');
        const view = EditorView.findFromDOM(document.querySelector('.cm-content'));
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '## abc\n\n## abc' } });
        view.dispatch({ changes: [{ from: 0, to: 2, insert: '###' }, { from: 8, to: 10, insert: '###' }] });
      });
      assert.equal(await page.locator('.cm-content .cm-line').count(), 3, `${name}: growing hidden markers must preserve all lines`);
      assert.equal(await page.locator('.cm-heading-text').count(), 2);
      assert.deepEqual(await page.locator('.cm-heading-text').allTextContents(), ['abc', 'abc']);
      assert.deepEqual(errors, [], `${name}: editor must not crash`);
      console.log(`${name}: task edit/new-note, select-all/delete, and hidden-marker growth passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
