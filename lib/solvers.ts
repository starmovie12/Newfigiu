import axios from 'axios';
import * as cheerio from 'cheerio';

// =============================================================================
// BROWSER-LIKE HEADERS — prevents 403 Forbidden on HubCloud
// The old minimal headers were getting blocked. These mimic a real Chrome
// browser session which dramatically reduces 403 rates.
// =============================================================================
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

const MOBILE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/**
 * Native Node.js implementation of the hblinks.dad solver.
 * FIX: Now checks multiple HubCloud TLD variants dynamically.
 */
export async function solveHBLinks(url: string) {
  try {
    const response = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 8000 });

    if (response.status !== 200) {
      return { status: "fail", message: `Cannot open page. Status: ${response.status}` };
    }

    const $ = cheerio.load(response.data);
    
    // Priority 1: Check all known HubCloud TLD variants
    const HUBCLOUD_TLDS = ['.foo', '.fans', '.dev', '.cloud', '.icu', '.lol', '.art', '.in', '.store'];
    for (const tld of HUBCLOUD_TLDS) {
      const found = $(`a[href*="hubcloud${tld}"]`).attr('href');
      if (found) {
        return { status: "success", link: found, source: `HubCloud${tld} (Priority 1)` };
      }
    }

    // Priority 2: HubDrive variants
    const HUBDRIVE_TLDS = ['.space', '.pro', '.in'];
    for (const tld of HUBDRIVE_TLDS) {
      const found = $(`a[href*="hubdrive${tld}"]`).attr('href');
      if (found) {
        return { status: "success", link: found, source: `HubDrive${tld} (Priority 2)` };
      }
    }

    // Priority 3: Generic fallback — any anchor containing hubcloud or hubdrive
    const genericHub = $('a[href*="hubcloud"], a[href*="hubdrive"]').first().attr('href');
    if (genericHub) {
      return { status: "success", link: genericHub, source: "HubCloud/HubDrive (Generic)" };
    }
        
    return { status: "fail", message: "Not Found" };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

const JUNK_LINK_TEXTS = [
  "how to download",
  "[how to download]",
  "how to watch",
  "[how to watch]",
  "join telegram",
  "join our telegram",
  "request movie",
  "4k | sdr | hevc",
  "4k | sdr",
  "sdr | hevc",
];

const JUNK_LINK_EXACT_TEXTS = [
  "4k",
  "sdr",
  "hevc",
];

function isJunkLink(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (JUNK_LINK_TEXTS.some(junk => lower.includes(junk))) return true;
  if (JUNK_LINK_EXACT_TEXTS.some(junk => lower === junk)) return true;
  return false;
}

export function extractMoviePreview(html: string): { title: string; posterUrl: string | null } {
  const $ = cheerio.load(html);

  let title = '';
  const h1 = $('h1.entry-title, h1.post-title, h1').first().text().trim();
  if (h1) {
    title = h1;
  } else {
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    title = ogTitle || $('title').text().trim() || 'Unknown Movie';
  }
  title = title.replace(/\s*[-\u2013|].*?(HDHub|HdHub|hdhub|Download|Free).*$/i, '').trim();

  let posterUrl: string | null = null;
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage && !ogImage.includes('logo') && !ogImage.includes('favicon')) {
    posterUrl = ogImage;
  } else {
    const contentImg = $('.entry-content img, .post-content img, main img').first().attr('src');
    if (contentImg && !contentImg.includes('logo') && !contentImg.includes('icon')) {
      posterUrl = contentImg;
    }
  }

  return { title, posterUrl };
}

export async function extractMovieLinks(url: string) {
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Referer": "https://hdhub4u.fo/"
  };

  const JUNK_DOMAINS = ["catimages", "imdb.com", "googleusercontent", "instagram.com", "facebook.com", "wp-content", "wpshopmart"];

  try {
    const response = await fetch(url, { headers: HEADERS });
    const html = await response.text();
    const $ = cheerio.load(html);

    const foundLinks: { name: string; link: string }[] = [];
    const metadata = extractMovieMetadata(html);
    const preview = extractMoviePreview(html);

    $('.entry-content a[href], main a[href]').each((_idx: number, el: any) => {
      const $a = $(el);
      const link = $a.attr('href') || '';
      const text = $a.text().trim();
      
      if (!link || link.startsWith('#') || JUNK_DOMAINS.some(junk => link.includes(junk))) return;
      if (isJunkLink(text)) return;
      
      const $parent = $a.closest('p, div, h3, h4');
      const parentText = $parent.text().trim();
      if (isJunkLink(parentText)) return;
      
      const isTargetDomain = ["hblinks", "hubdrive", "hubcdn", "hubcloud", "gdflix", "drivehub"].some(d => link.includes(d));
      const isDownloadText = ["DOWNLOAD", "720P", "480P", "1080P", "4K", "DIRECT", "GDRIVE"].some(t => text.toUpperCase().includes(t));

      if (isTargetDomain || isDownloadText) {
        if (!foundLinks.some(x => x.link === link)) {
          let cleanName = text.replace(/\u26A1/g, "").trim();
          if (!cleanName || cleanName.length < 2) {
            const parent = $a.closest('p, div, h3, h4');
            const prev = parent.prev('h3, h4, h5, strong');
            cleanName = prev.text().trim() || parent.text().trim() || "Download Link";
          }
          
          if (!isJunkLink(cleanName)) {
            foundLinks.push({ name: cleanName.substring(0, 50), link: link });
          }
        }
      }
    });

    if (foundLinks.length === 0) {
      return { status: "error", message: "No links found. The page structure might have changed." };
    }

    return { 
      status: "success", 
      total: foundLinks.length, 
      links: foundLinks, 
      metadata,
      preview
    };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

export function extractMovieMetadata(html: string): {
  quality: string;
  languages: string;
  audioLabel: string;
} {
  const $ = cheerio.load(html);

  const validLangs = [
    'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam',
    'Kannada', 'Punjabi', 'Marathi', 'Bengali', 'Spanish',
    'French', 'Korean', 'Japanese', 'Chinese'
  ];

  const foundLanguages = new Set<string>();
  const qualityInfo = { resolution: '', format: '' };

  const formatPriority: Record<string, number> = {
    'WEB-DL': 5, 'BluRay': 4, 'WEBRip': 3, 'HEVC': 2, 'x264': 1, 'HDTC': 0, '10Bit': 0
  };

  let $mainContent: any = $('main.page-body');
  if ($mainContent.length === 0) $mainContent = $('div.entry-content');
  if ($mainContent.length === 0) $mainContent = $.root();

  let $downloadSection: ReturnType<typeof $> | null = null;
  $mainContent.find('h2, h3, h4').each((_i: number, heading: any) => {
    const headingText = $(heading).text().toUpperCase();
    if (headingText.includes('DOWNLOAD LINKS')) {
      $downloadSection = $(heading).parent();
      return false;
    }
  });
  if (!$downloadSection) $downloadSection = $mainContent;

  const downloadLinks = ($downloadSection as ReturnType<typeof $>).find('a[href]');

  downloadLinks.each((_i, el) => {
    const href = $(el).attr('href') || '';
    const cdnDomains = ['hubcdn', 'hubdrive', 'gadgetsweb', 'hubstream', 'hdstream', 'hblinks', 'hubcloud', 'gdflix', 'drivehub'];
    if (!cdnDomains.some(d => href.toLowerCase().includes(d))) return;

    const $parent = $(el).closest('h3, h4, p');
    const buttonLabel = $parent.length ? $parent.text().trim() : $(el).text().trim();

    for (const lang of validLangs) {
      const regex = new RegExp(`\\b${lang}\\b`, 'i');
      if (regex.test(buttonLabel)) {
        foundLanguages.add(lang);
      }
    }

    const qualityMatch = buttonLabel.match(/(480p|720p|1080p|2160p|4K)/i);
    if (qualityMatch) {
      const res = qualityMatch[1].toUpperCase();
      const currentResVal = parseInt((qualityInfo.resolution.replace(/\D/g, '') || '0'), 10);
      const newResVal = parseInt((res.replace(/\D/g, '') || '0'), 10);
      if (newResVal > currentResVal) {
        qualityInfo.resolution = res;
      }
    }

    const formatPatterns: [RegExp, string][] = [
      [/WEB-DL/i, 'WEB-DL'], [/BLURAY|BLU-RAY/i, 'BluRay'], [/WEBRIP|WEB-RIP/i, 'WEBRip'],
      [/HDTC|HD-TC/i, 'HDTC'], [/HEVC|H\.265|x265/i, 'HEVC'], [/x264|H\.264/i, 'x264'],
      [/10[- ]?Bit/i, '10Bit'],
    ];

    for (const [pattern, formatName] of formatPatterns) {
      if (pattern.test(buttonLabel)) {
        const currentPriority = formatPriority[qualityInfo.format] ?? -1;
        const newPriority = formatPriority[formatName] ?? -1;
        if (newPriority > currentPriority) {
          qualityInfo.format = formatName;
        }
        break;
      }
    }
  });

  const pageText = ($downloadSection as ReturnType<typeof $>).text();
  const multiMatch = pageText.match(/MULTi[\s\S]*?\[([\s\S]*?HINDI[\s\S]*?)\]/i);
  if (multiMatch) {
    const langString = multiMatch[1];
    for (const lang of validLangs) {
      const regex = new RegExp(`\\b${lang}\\b`, 'i');
      if (regex.test(langString)) {
        foundLanguages.add(lang);
      }
    }
  }

  if (foundLanguages.size === 0) {
    $mainContent.find('div, span, p').each((_i: number, elem: any) => {
      const text = $(elem).text();
      const langFieldMatch = text.match(/Language\s*:(.+?)(?:\n|\/|$)/i);
      if (langFieldMatch) {
        const langLine = langFieldMatch[1];
        for (const lang of validLangs) {
          const regex = new RegExp(`\\b${lang}\\b`, 'i');
          if (regex.test(langLine)) {
            foundLanguages.add(lang);
          }
        }
        return false;
      }
    });
  }

  if (!qualityInfo.resolution) {
    $mainContent.find('div, span, p').each((_i: number, elem: any) => {
      const text = $(elem).text();
      if (/Quality\s*:/i.test(text)) {
        const qualityMatch = text.match(/Quality\s*:(.+?)(?:\n|$)/i);
        if (qualityMatch) {
          const qualityLine = qualityMatch[1];
          const resMatch = qualityLine.match(/(480p|720p|1080p|2160p|4K)/i);
          if (resMatch) {
            qualityInfo.resolution = resMatch[1].toUpperCase();
          }
          const fallbackFormatPatterns: [RegExp, string][] = [
            [/WEB-DL/i, 'WEB-DL'], [/BLURAY|BLU-RAY/i, 'BluRay'], [/WEBRIP|WEB-RIP/i, 'WEBRip'],
            [/HDTC|HD-TC/i, 'HDTC'], [/HEVC|H\.265|x265/i, 'HEVC'], [/x264|H\.264/i, 'x264'],
          ];
          for (const [pattern, formatName] of fallbackFormatPatterns) {
            if (pattern.test(qualityLine)) {
              qualityInfo.format = formatName;
              break;
            }
          }
        }
        return false;
      }
    });
  }

  const langList = Array.from(foundLanguages).sort();
  const count = langList.length;

  let audioLabel = 'Not Found';
  if (count === 1) audioLabel = langList[0];
  else if (count === 2) audioLabel = 'Dual Audio';
  else if (count >= 3) audioLabel = 'Multi Audio';

  let finalQuality = 'Unknown Quality';
  if (qualityInfo.resolution) {
    finalQuality = `${qualityInfo.resolution} ${qualityInfo.format}`.trim();
  }

  return {
    quality: finalQuality,
    languages: langList.length > 0 ? langList.join(', ') : 'Not Specified',
    audioLabel: audioLabel
  };
}

export async function solveHubCDN(url: string) {
  const headers = {
    ...MOBILE_HEADERS,
  };

  try {
    let targetUrl = url;

    if (!url.includes("/dl/")) {
      const resp = await axios.get(url, { headers, timeout: 8000 });
      const html = resp.data;
      
      const reurlMatch = html.match(/var reurl = "(.*?)"/);
      if (reurlMatch) {
        // FIX: Decode &amp; BEFORE parsing URL
        const cleanRedirectUrl = reurlMatch[1].replace(/&amp;/g, '&');
        const urlObj = new URL(cleanRedirectUrl);
        const rParam = urlObj.searchParams.get('r');
        
        if (rParam) {
          const paddedB64 = rParam + "=".repeat((4 - rParam.length % 4) % 4);
          targetUrl = Buffer.from(paddedB64, 'base64').toString('utf-8');
        }
      }
    }

    const finalResp = await axios.get(targetUrl, { headers, timeout: 8000 });
    const $ = cheerio.load(finalResp.data);
    
    const linkTag = $('a#vd');
    const finalLink = linkTag.attr('href');

    if (finalLink) {
      return { status: "success", final_link: finalLink };
    }

    const scriptMatch = finalResp.data.match(/window\.location\.href\s*=\s*"(.*?)"/);
    if (scriptMatch) {
      return { status: "success", final_link: scriptMatch[1] };
    }

    return { status: "failed", message: "Link id='vd' not found in HTML" };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

export async function solveHubDrive(url: string) {
  try {
    const response = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 8000 });
    const $ = cheerio.load(response.data);

    let finalLink = "";

    const btnSuccess = $('a.btn-success[href*="hubcloud"]');
    if (btnSuccess.length > 0) {
      finalLink = btnSuccess.attr('href') || "";
    }

    if (!finalLink) {
      const dlBtn = $('a#dl');
      if (dlBtn.length > 0) {
        finalLink = dlBtn.attr('href') || "";
      }
    }

    if (!finalLink) {
      $('a[href]').each((_i: number, el: any) => {
        const href = $(el).attr('href') || "";
        if (href.includes('hubcloud') || href.includes('hubcdn')) {
          finalLink = href;
          return false;
        }
      });
    }

    if (finalLink) {
      return { status: "success", link: finalLink };
    }

    return { status: "fail", message: "Download link not found on HubDrive page" };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

// =============================================================================
// NATIVE HUBCLOUD SOLVER
//
// 403 FIX: 3 key changes:
// 1. Uses full BROWSER_HEADERS instead of minimal headers (prevents WAF blocks)
// 2. validateStatus allows 403 — some HubCloud pages return 403 but still
//    contain the download buttons in the HTML body
// 3. Retry with mobile User-Agent if desktop headers get 403
// =============================================================================

interface HubCloudButton {
  button_name: string;
  download_link: string;
}

export interface HubCloudNativeResult {
  status: 'success' | 'error';
  best_button_name?: string;
  best_download_link?: string;
  all_available_buttons?: HubCloudButton[];
  message?: string;
}

export async function solveHubCloudNative(url: string): Promise<HubCloudNativeResult> {
  try {
    let cleanUrl = decodeURIComponent(url).trim();
    const httpIdx = cleanUrl.indexOf('http');
    if (httpIdx > 0) {
      cleanUrl = cleanUrl.substring(httpIdx);
    }

    console.log(`[HubCloud Native] Processing: ${cleanUrl}`);

    // Try with desktop headers first, then mobile if 403
    const headerSets = [
      { ...BROWSER_HEADERS, "Referer": "https://hdhub4u.fo/" },
      { ...MOBILE_HEADERS, "Referer": "https://hdhub4u.fo/" },
    ];

    let finalHtml: string = '';
    let gotPage = false;

    for (let attempt = 0; attempt < headerSets.length; attempt++) {
      const headers = headerSets[attempt];
      try {
        // FIX: Accept 403 responses — HubCloud often returns 403 but includes
        // the download page in the body. The old code rejected 403 entirely.
        const resp = await axios.get(cleanUrl, {
          headers,
          timeout: 8000,
          maxRedirects: 5,
          validateStatus: (status: number) => status < 500, // Accept 2xx, 3xx, 4xx
        });

        // If we got HTML content, use it regardless of status code
        if (resp.data && typeof resp.data === 'string' && resp.data.length > 100) {
          finalHtml = resp.data;
          gotPage = true;

          // Step 2: Find Intermediate Link
          const pattern1 = /id="download"[^>]*href="([^"]+)"/;
          const pattern2 = /var url = '([^']+)'/;
          const pattern3 = /href="([^"]+hubcloud\.php\?[^"]+)"/;

          const intermediateMatch = pattern1.exec(resp.data) || pattern2.exec(resp.data) || pattern3.exec(resp.data);

          if (intermediateMatch) {
            const intermediateLink = intermediateMatch[1].replace(/&amp;/g, '&');
            console.log('[HubCloud Native] Found intermediate link, redirecting...');

            try {
              const finalResp = await axios.get(intermediateLink, {
                headers,
                timeout: 8000,
                maxRedirects: 10,
                validateStatus: (status: number) => status < 500,
              });
              if (finalResp.data && typeof finalResp.data === 'string' && finalResp.data.length > 100) {
                finalHtml = finalResp.data;
              }
            } catch (intermediateErr: any) {
              console.warn(`[HubCloud Native] Intermediate link failed: ${intermediateErr.message}, using initial page`);
            }
          }

          break; // Got a page, stop retrying
        }

        // If 403 with no useful body, try next header set
        if (resp.status === 403) {
          console.log(`[HubCloud Native] Attempt ${attempt + 1} got 403 with empty body, retrying...`);
          continue;
        }
      } catch (reqErr: any) {
        console.warn(`[HubCloud Native] Attempt ${attempt + 1} failed: ${reqErr.message}`);
        if (attempt === headerSets.length - 1) {
          throw reqErr; // All attempts failed
        }
      }
    }

    if (!gotPage || !finalHtml) {
      return {
        status: 'error',
        message: 'Failed to fetch HubCloud page (all attempts returned empty/blocked)',
      };
    }

    // Step 4: Extract Direct Links and Button Names
    const rawLinkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const allExtractedLinks: HubCloudButton[] = [];

    let regexMatch: RegExpExecArray | null;
    while ((regexMatch = rawLinkRegex.exec(finalHtml)) !== null) {
      const href = regexMatch[1];
      const innerHTML = regexMatch[2];

      let cleanName = innerHTML.replace(/<[^>]+>/g, '').trim();
      cleanName = cleanName.replace(/\s+/g, ' ');

      if (!cleanName) continue;
      if (cleanName.toLowerCase().includes('telegram')) continue;
      if (cleanName.toLowerCase().includes('android app')) continue;

      const hasToken = href.includes('token=');
      const hasServer = cleanName.toLowerCase().includes('server');
      const hasDownload = cleanName.toLowerCase().includes('download');

      if (hasToken || hasServer || hasDownload) {
        allExtractedLinks.push({
          button_name: cleanName,
          download_link: href,
        });
      }
    }

    if (allExtractedLinks.length === 0) {
      return {
        status: 'error',
        message: 'No valid download button found on the page.',
      };
    }

    // Step 5: Priority Logic
    let bestLink: string | null = null;
    let bestButtonName: string | null = null;

    // Priority 1: "FSL Server" (non-v2)
    for (const item of allExtractedLinks) {
      if (item.button_name.includes('FSL Server') && !item.button_name.includes('v2')) {
        bestLink = item.download_link;
        bestButtonName = item.button_name;
        break;
      }
    }

    // Priority 2: FSLv2 or any token/Server link
    if (!bestLink) {
      for (const item of allExtractedLinks) {
        if (item.download_link.includes('token=') || item.button_name.includes('Server')) {
          bestLink = item.download_link;
          bestButtonName = item.button_name;
          break;
        }
      }
    }

    // Priority 3: Fallback to first link
    if (!bestLink && allExtractedLinks.length > 0) {
      bestLink = allExtractedLinks[0].download_link;
      bestButtonName = allExtractedLinks[0].button_name;
    }

    return {
      status: 'success',
      best_button_name: bestButtonName || undefined,
      best_download_link: bestLink || undefined,
      all_available_buttons: allExtractedLinks,
    };

  } catch (e: any) {
    return {
      status: 'error',
      message: e.message,
    };
  }
}
