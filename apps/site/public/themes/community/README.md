# Community themes

Themes in this folder appear in the gallery at
[sketchor.sergioalexo.com/themes](https://sketchor.sergioalexo.com/themes).

To submit one:

1. Make the theme in Sketchor: open the theme menu (the palette button in the
   top bar), choose **Customize current theme…**, then **Export .json**. That
   gives you a `<id>.sketchor-theme.json` file.
2. Fork the repository and add that file here as
   `apps/site/public/themes/community/<id>.sketchor-theme.json`. The file name
   must match the theme's `id` (lowercase letters, digits and dashes) and must
   not reuse the id of a theme Sketchor ships.
3. Fill in `name` and `author` (your name or handle) in the file.
4. Run `npx vitest run apps/site/src/lib/themes.test.ts` from the repository
   root. It checks the file with the same validator the app uses before
   installing a theme.
5. Open a pull request.

Themes contain colours only (and font names). They can't run code, load
images or reach the network, and the app rejects any file that tries.
Submitted themes are MIT licensed, like the embed.
