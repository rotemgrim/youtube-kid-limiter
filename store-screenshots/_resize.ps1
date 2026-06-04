Add-Type -AssemblyName System.Drawing
$dir = "C:\Users\rotem\projects\youtube-kid-limiter\store-screenshots"
$outDir = Join-Path $dir "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$TW = 1280; $TH = 800

Get-ChildItem -Path $dir -Filter "Screenshot_*.png" | ForEach-Object {
  $src = [System.Drawing.Image]::FromFile($_.FullName)
  $w = $src.Width; $h = $src.Height
  $scale = [Math]::Max($TW / $w, $TH / $h)
  $sw = [int][Math]::Ceiling($w * $scale)
  $sh = [int][Math]::Ceiling($h * $scale)

  $scaled = New-Object System.Drawing.Bitmap $sw, $sh
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $sw, $sh)
  $g.Dispose()
  $src.Dispose()

  $cx = [int](($sw - $TW) / 2)
  $cy = [int](($sh - $TH) / 2)
  $out = New-Object System.Drawing.Bitmap $TW, $TH, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.DrawImage($scaled, (New-Object System.Drawing.Rectangle 0, 0, $TW, $TH), (New-Object System.Drawing.Rectangle $cx, $cy, $TW, $TH), [System.Drawing.GraphicsUnit]::Pixel)
  $g2.Dispose()
  $scaled.Dispose()

  $outPath = Join-Path $outDir $_.Name
  $out.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  "{0}: {1}x{2} -> 1280x800" -f $_.Name, $w, $h
}
