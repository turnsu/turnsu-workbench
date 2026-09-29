# Third-party component notice

The desktop UI adapts the Button, Badge, Input, Textarea primitives and design tokens from
[turnsu/frontend-scaffold](https://github.com/turnsu/frontend-scaffold/tree/02203ea4ecdd2da3a2c22e7accc196f5b5e7ab35)
at commit `02203ea4ecdd2da3a2c22e7accc196f5b5e7ab35`. The upstream application uses
Tailwind and Base UI; this adaptation uses the existing desktop React/esbuild entry and native
HTML controls. Upstream demo routes, data and SSR services are not included.

Electron runtime licenses are distributed by the Electron packager alongside the application.
Bundled Host dependencies and their notices are under `host-dist/notices/` inside the development
package. Company llm-gateway is integrated over its API; its admin UI source is not bundled.

MIT License

Copyright (c) 2026 Mohammed Arham Khan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
