import type { Page } from 'playwright';
import { clickStable, findVisible } from './locator.js';

export async function selectImageFile(page: Page, imagePath: string): Promise<void> {
  const fileInput = page.locator('.image-upload-button-container input[type="file"], input[type="file"][accept*="image" i]').first();
  if (await fileInput.waitFor({ state: 'attached', timeout: 4000 }).then(() => true, () => false)) {
    await fileInput.setInputFiles(imagePath, { timeout: 8000 });
    return;
  }
  // Some versions of the upload panel create a file input only on click.
  const chosen = page.waitForEvent('filechooser', { timeout: 8000 }).then(chooser => chooser.setFiles(imagePath));
  await Promise.all([chosen, clickImageUploadButton(page)]);
}

async function clickImageUploadButton(page: Page): Promise<void> {
  await clickStable(
    page,
    [
      { kind: 'role', role: 'button', name: /上传图片|图片上传|选择图片/ },
      { kind: 'css', selector: '.image-upload-button-container' },
      { kind: 'css', selector: '[class*="image-upload"]' },
    ],
    {
      description: 'image search upload button',
      timeoutMs: 8000,
    },
  );
}

export async function clickImageSearchButton(page: Page): Promise<void> {
  const submit = await findVisible(
    page,
    [
      { kind: 'css', selector: '.search-image-upload-container .search-btn[data-tracker="pasteImagePreview"]' },
      { kind: 'role', role: 'button', name: /^搜索图片$/ },
      { kind: 'text', text: /^搜索图片$/ },
    ],
    {
      description: 'image search submit button',
      timeoutMs: 20000,
      scrollIntoView: false,
    },
  );

  // Activate the visible upload preview in place. Moving the pointer can dismiss it.
  await submit.evaluate((button: HTMLElement) => button.click());
}
