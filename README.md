# Personal website

A plain HTML and CSS site with no build step, ready for GitHub Pages.

```
index.html                         Home
research.html                      Research
music.html                         Music
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

## Music visualizer

`music.html` uses a MiniMeters-style player (`assets/meters.js`, `assets/meters.css`, `assets/meters-worklet.js`) with a waveform overview, spectrum analyzer, stereometer, peak/LUFS meter, spectrogram and oscilloscope.

To add a track, run this from the site folder (needs ffmpeg and numpy):

```
python3 tools/prepare_track.py ~/Music/my-track.wav my-track
```

It writes `assets/audio/my-track.mp3` and `assets/audio/my-track.peaks.json`. Then add a player anywhere on a page that loads `meters.css` and `meters.js`:

```html
<div class="meters" data-src="assets/audio/my-track.mp3" data-peaks="assets/audio/my-track.peaks.json"
     data-title="Track title" data-artist="Artist"></div>
```

Audio has to be hosted on this site: browsers don't let a page analyze SoundCloud or Mixcloud audio. GitHub rejects files over 100 MB, which is roughly 40 minutes at 320 kbps, so encode long mixes at a lower bitrate or host them elsewhere.

To test locally, serve the folder instead of opening the file directly: `python3 -m http.server`, then visit http://localhost:8000/music.html. (Python's server can't seek within a track; GitHub Pages can.)
