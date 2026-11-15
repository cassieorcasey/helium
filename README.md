# Helium

Pemutar audio lokal bergaya iPod, dibangun dengan HTML, CSS, dan JavaScript murni. Desainnya mengikuti spesifikasi **Anodized & Liquid Glass**: bodi *anodized* yang bersih, kaca cair hanya pada kontrol mengambang, dan *Virtual Rotary Scrubber* sebagai interaksi utama.

Tidak ada login, iklan, umpan algoritmik, *build step*, atau dependensi. Semua data tetap di perangkatmu.

## Menjalankan

Buka `index.html` langsung di browser, atau sajikan foldernya:

```bash
python3 -m http.server 8000
```

Lalu buka `http://localhost:8000` dan klik **Pilih Folder Musik**. Kamu juga bisa menyeret folder ke jendela.

Di Chrome/Edge, Helium memakai File System Access API dan mengingat folder musikmu. Setelah browser dibuka ulang, cukup klik **Hubungkan ulang** sekali. Di Firefox/Safari, folder dipilih ulang setiap sesi, tapi indeks metadata dan cover art tetap di-cache.

## Fitur

| Area | Detail |
| --- | --- |
| Format | FLAC, ALAC, WAV, MP3, AAC/M4A, Ogg Vorbis, Opus. Dukungan pemutaran mengikuti browser: ALAC hanya diputar di Safari. |
| Metadata | Parser bawaan untuk ID3v2.2–2.4/ID3v1, Vorbis Comments (FLAC/Ogg/Opus), MP4 `ilst` atoms, dan RIFF INFO. Membaca *embedded cover art*, bit depth, sample rate, bitrate, dan durasi tanpa men-decode audio. |
| Indeks | Hanya byte yang diperlukan yang dibaca. Hasilnya di-cache di IndexedDB berdasarkan path + ukuran + waktu modifikasi, jadi pemindaian ulang hampir instan. Cover art di-dedup per album. `cover.jpg`/`folder.jpg` dipakai sebagai cadangan. |
| Library | Artists, Albums (termasuk multi-disc), Songs, Local Folders, dan Playlists dari file `.m3u`/`.m3u8` di folder musik. |
| Smart Collections | Recently Added, Heavy Rotation, Never Played, dihitung dari riwayat putar yang disimpan lokal. Satu putaran dihitung setelah 30 detik atau separuh durasi lagu. |
| Gapless | Dua elemen audio bergantian. Trek berikutnya dipramuat lalu dimulai lewat timer ketat di akhir trek. FLAC/WAV/ALAC tersambung mulus. MP3/AAC bisa menyisakan beberapa milidetik *encoder padding*. |
| Lirik | File `.lrc` dengan nama sama di folder lagu (atau lirik tertanam) ditampilkan di balik kartu album, dengan *active line highlight*, *smooth auto-scroll*, dan klik baris untuk melompat. |
| Rotary Scrubber | Putar cincin untuk *scrubbing* per detik (berakselerasi saat diputar cepat) atau mengatur volume. Ada detent setiap 15° dengan haptik (`navigator.vibrate(4)`) dan klik mekanis sintetis. Keduanya bisa dimatikan. Cincin juga bisa dioperasikan dengan keyboard dan *scroll wheel*. |
| Motion | Pegas yang bisa diinterupsi (stiffness 380, damping 32, mass 1) untuk sheet Now Playing, navigasi mobile, dan flip lirik. Sheet bisa diseret ke bawah untuk ditutup. Saat `prefers-reduced-motion` aktif, animasi berubah jadi *cross-fade* 150 ms. |
| Sistem | Media Session API (kontrol di lock screen/OS), sesi terakhir dilanjutkan otomatis, tema Otomatis/Terang/Gelap. |

## Pintasan keyboard

| Tombol | Aksi |
| --- | --- |
| `Space` | Play / Pause |
| `←` / `→` | Mundur / maju 5 detik |
| `Shift` + `←` / `→` | Trek sebelumnya / berikutnya |
| `↑` / `↓` | Volume ±5% |
| `L` | Tampilkan / sembunyikan lirik |
| `⌘/Ctrl` + `F` | Cari di library |
| `Esc` | Tutup panel / kembali |

## Struktur

```
index.html        markup, ikon SVG, dialog pengaturan
css/helium.css    token warna (Light/Dark), Liquid Glass, layout split-pane & compact
js/metadata.js    pembaca tag & properti stream (tanpa library eksternal)
js/store.js       IndexedDB (handle, cache metadata, cover art) + localStorage
js/library.js     pemindaian, indeks, koleksi, smart playlists, statistik putar
js/engine.js      mesin audio dual-buffer (gapless)
js/lrc.js         parser .lrc
js/motion.js      fisika pegas
js/wheel.js       Virtual Rotary Scrubber
js/app.js         navigasi, tampilan, antrean, Now Playing, pintasan
```

Modul `js/metadata.js` juga bisa dipakai di Node (`require('./js/metadata.js').parse(file)`) dengan objek `File`/`Blob`.
