# Personal website

A plain HTML and CSS site with no build step, ready for GitHub Pages.

```
index.html                         Home
research.html                      Research
teaching.html                      Teaching
projects/index.html                Projects
projects/color-code-lab/index.html Color code lab (interactive companion)
assets/style.css                   Shared styles
.nojekyll                          Tells GitHub Pages to serve the files as they are
```

## Fill in your details

Search every `.html` file for square brackets, `[`, and replace each placeholder: your name, title, university, advisor, email, links, papers and courses. To add a photo, save it as `assets/photo.jpg` and swap the placeholder `div` on the home page for the `img` tag in the comment above it. To link a CV, save it as `assets/cv.pdf`.

## Publish on GitHub Pages

1. On GitHub, create a new public repository named `<username>.github.io`, using your username in lowercase.
2. Upload the contents of this folder to the top level of the repository, including the hidden `.nojekyll` file. On the repository page, use Add file → Upload files, or push with git.
3. In the repository, go to Settings → Pages. Under Build and deployment, choose Deploy from a branch, branch `main`, folder `/ (root)`, and save.
4. Changes can take up to 10 minutes to appear. The site will be at `https://<username>.github.io/`.

## Adding a project

Create a folder under `projects/` containing an `index.html`, then add a card for it in `projects/index.html`.
