"""Capture current public UI with an empty user workspace, without inference.

Requires Playwright and Chrome. Personal history/projects are hidden only in this
isolated browser context; this script never modifies stored data or sends tasks.
"""
import argparse
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3000/')
    parser.add_argument('--output', type=Path, default=Path('docs/images'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        page = browser.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1)
        for endpoint in ('assistant/history', 'projects'):
            page.route('**/api/v1/' + endpoint + '*', lambda route: route.fulfill(json={'data': []}))
        # Never allow a screenshot session to submit an inference request.
        def prevent_inference(route):
            if route.request.method == 'POST':
                route.abort()
            else:
                route.continue_()
        page.route('**/api/v1/assistant/chat*', prevent_inference)
        page.route('**/api/v1/assistant/image-operations*', prevent_inference)
        page.goto(args.url, wait_until='networkidle')
        group = page.get_by_role('group', name='Chat-AI 工作模式', exact=True)
        for mode in ('Chat', 'Work', 'Image'):
            group.get_by_role('button', name=mode, exact=True).click()
            page.wait_for_timeout(800)
            assert group.locator('[aria-pressed="true"]').count() == 1
            assert group.get_by_role('button', name=mode, exact=True).get_attribute('aria-pressed') == 'true'
            if mode == 'Image':
                gallery = page.get_by_role('region', name='热门图片风格')
                assert gallery.get_by_role('button').count() == 12, 'Image gallery previews are missing'
                assert page.evaluate('''async () => {
                    const image = new Image();
                    image.src = '/image-style-presets/popular-style-sprite.png';
                    await image.decode();
                    return image.naturalWidth > 0;
                }'''), 'Image sprite failed to load'
            page.screenshot(path=str(args.output / (mode.lower() + '-workspace.png')))
            if mode == 'Image' and urlsplit(args.url).hostname not in ('localhost', '127.0.0.1'):
                page.get_by_role('textbox', name='输入问题', exact=True).fill('仅验证线上界面，不生成图片')
                assert page.get_by_role('button', name='发送问题', exact=True).is_disabled()
                print('Public Image: preview available; inference submission disabled')
            print(f'{mode}: exclusive active tab verified; screenshot saved')
        group.get_by_role('button', name='Chat', exact=True).click()
        page.wait_for_timeout(400)
        assert page.locator('[data-image-mode="true"]').count() == 0
        print('Image -> Chat: image mode is disabled')
        wechat = group.get_by_role('button', name='Wechat Agent', exact=True)
        if wechat.count():
            wechat.click()
            page.wait_for_timeout(800)
            page.screenshot(path=str(args.output / 'wechat-workspace.png'))
            print('Wechat Agent: dedicated workspace screenshot saved')
        browser.close()


if __name__ == '__main__':
    main()
