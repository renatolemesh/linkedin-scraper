const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL;
const LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD;
const linkedinDir = path.join(__dirname, 'linkedin');
const COOKIES_FILE = path.join(linkedinDir, 'cookies.json');
const profileURLsPath = path.join(linkedinDir, 'profiles.csv');
const DOWNLOAD_FOLDER = path.join(linkedinDir, 'pdfs');

async function getDriver(){
    try{
        const options = new chrome.Options();
        options.addArguments('--disable-blink-features=AutomationControlled');
        options.addArguments('--start-maximized');
        
        // Set download preferences
        const prefs = {
            'download.default_directory': DOWNLOAD_FOLDER,
            'download.prompt_for_download': false,
            'plugins.always_open_pdf_externally': true,
            'download.directory_upgrade': true,
            'safebrowsing.enabled': true
        };
        options.setUserPreferences(prefs);
        
        const driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();

        return driver;
    } catch(e) {
        console.log('Error getting driver', e);
        return null;
    }
}

async function loginToLinkedIn(driver) {
  try {
    console.log('Opening LinkedIn login page...');
    await driver.get('https://www.linkedin.com/login');

    console.log('Entering credentials...');
    const emailInput = await driver.wait(
      until.elementLocated(By.id('username')),
      10000
    );
    await emailInput.sendKeys(LINKEDIN_EMAIL);

    const passwordInput = await driver.findElement(By.id('password'));
    await passwordInput.sendKeys(LINKEDIN_PASSWORD);

    const loginButton = await driver.findElement(
      By.css('button[type="submit"]')
    );
    await loginButton.click();

    console.log('Logging in...');
    await driver.wait(async () => {
      const url = await driver.getCurrentUrl();
      return url.includes('linkedin.com/feed') || 
             url.includes('linkedin.com/check/add-phone');
    }, 15000);

    console.log('Login successful!');

    const cookies = await driver.manage().getCookies();
    await fs.writeFile(
      COOKIES_FILE,
      JSON.stringify(cookies, null, 2),
      'utf8'
    );
    
    console.log(`Cookies saved to ${COOKIES_FILE}`);
    console.log(`Total cookies saved: ${cookies.length}`);

    await driver.sleep(3000);
    return true;

  } catch (error) {
    console.error('Error during login:', error.message);
  }
  return false;
}

async function loadCookies(driver) {
  try {
    const cookiesData = await fs.readFile(COOKIES_FILE, 'utf8');
    const cookies = JSON.parse(cookiesData);
    
    await driver.get('https://www.linkedin.com');
    
    for (const cookie of cookies) {
      try {
        await driver.manage().addCookie(cookie);
      } catch (err) {
        console.warn(`Could not add cookie ${cookie.name}:`, err.message);
      }
    }
    
    console.log('Cookies loaded successfully!');
    await driver.navigate().refresh();
    
  } catch (error) {
    console.error('Error loading cookies:', error.message);
    throw error;
  }
}

async function loginWithSavedCookies(driver) {
  try {
    await loadCookies(driver);
    await driver.get('https://www.linkedin.com/feed/');
    console.log('Trying to log in with saved cookies!');

    let emailInput;
    try {
      emailInput = await driver.wait(
        until.elementLocated(By.id('username')),
        10000
      );
    } catch (error) {
      console.log('Login input not found, probably already logged in!');
    }

    if(emailInput){
        console.log('Not logged, trying to login again...');
        const success = await loginToLinkedIn(driver);
        if(!success){
            console.log('Login failed');
            return false;
        }
    }
    console.log('Login successful!');
    return true;
    
  } catch (error) {
    console.error('Error:', error.message);
  } 
}

async function sleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract profile identifier from LinkedIn URL
function extractProfileId(url) {
  try {
    // Examples:
    // https://www.linkedin.com/in/john-doe-123456/ -> john-doe-123456
    // https://linkedin.com/in/jane-smith/ -> jane-smith
    const match = url.match(/\/in\/([^\/\?]+)/);
    if (match && match[1]) {
      return match[1].replace(/\/$/, ''); // Remove trailing slash if exists
    }
    return null;
  } catch(e) {
    console.log('Error extracting profile ID:', e.message);
    return null;
  }
}

// Wait for file to be downloaded
async function waitForDownload(downloadPath, timeout = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const files = await fs.readdir(downloadPath);
      
      // Find PDF files that are not .crdownload (Chrome temp files)
      const pdfFiles = files.filter(f => 
        f.endsWith('.pdf') && !f.endsWith('.crdownload')
      );
      
      if (pdfFiles.length > 0) {
        // Return the most recently created PDF
        const pdfStats = await Promise.all(
          pdfFiles.map(async f => ({
            name: f,
            time: (await fs.stat(path.join(downloadPath, f))).mtime.getTime()
          }))
        );
        pdfStats.sort((a, b) => b.time - a.time);
        return pdfStats[0].name;
      }
    } catch(e) {
      // Directory might not exist yet
    }
    
    await sleep(500);
  }
  
  return null;
}

// Rename downloaded PDF to profile name
async function renameDownloadedPdf(profileId, downloadFolder) {
  try {
    const files = await fs.readdir(downloadFolder);
    
    // Find the most recent PDF (usually named "Profile.pdf" by LinkedIn)
    const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
    
    if (pdfFiles.length === 0) {
      console.log('No PDF file found to rename');
      return false;
    }
    
    // Get file stats to find most recent
    const pdfStats = await Promise.all(
      pdfFiles.map(async f => ({
        name: f,
        path: path.join(downloadFolder, f),
        time: (await fs.stat(path.join(downloadFolder, f))).mtime.getTime()
      }))
    );
    
    pdfStats.sort((a, b) => b.time - a.time);
    const mostRecentPdf = pdfStats[0];
    
    // New filename with profile ID
    const newFileName = `${profileId}.pdf`;
    const newFilePath = path.join(downloadFolder, newFileName);
    
    // Check if file with same name already exists
    try {
      await fs.access(newFilePath);
      console.log(`File ${newFileName} already exists, adding timestamp...`);
      const timestamp = Date.now();
      const timestampedName = `${profileId}_${timestamp}.pdf`;
      await fs.rename(mostRecentPdf.path, path.join(downloadFolder, timestampedName));
      console.log(`✅ Renamed to: ${timestampedName}`);
      return true;
    } catch(e) {
      // File doesn't exist, proceed with rename
      await fs.rename(mostRecentPdf.path, newFilePath);
      console.log(`✅ Renamed to: ${newFileName}`);
      return true;
    }
    
  } catch(e) {
    console.log('Error renaming PDF:', e.message);
    return false;
  }
}

async function proccessProfiles(driver){
  const URLs = await getProfileURLs();
  
  for(let i = 0; i < URLs.length; i++){
    const url = URLs[i].trim();
    if(!url) continue;
    
    const profileId = extractProfileId(url);
    if(!profileId) {
      console.log(`\n[${i+1}/${URLs.length}] Could not extract profile ID from: ${url}`);
      continue;
    }
    
    console.log(`\n[${i+1}/${URLs.length}] Processing: ${profileId}`);
    console.log(`URL: ${url}`);
    
    try {
      await driver.get(url);
      await sleep(3000);

      // Try to find more button
      const overflowActions = await driver.findElements(
        By.xpath('//button[contains(@id, "profile-overflow-action")]')
      );
      const secondOverflowAction = overflowActions[1] ?? null;
      
      if(!secondOverflowAction) {
        console.log('Could not find second overflow action, skipping...');
        continue;
      }
    
      // Now find and click the "Save to PDF" option
      try {
        console.log('Clicking More button...');
        await secondOverflowAction.click();
        await sleep(1000);

        // Try to find the PDF button in the dropdown
        const pdfButton = await driver.findElement(
          By.xpath('//div[@role="button" and contains(., "Save to PDF")]')
        );
        
        console.log('Found Save to PDF button, clicking...');
        await driver.executeScript("arguments[0].click();", pdfButton);
        
        console.log('PDF download initiated! Waiting for download...');
        
        // Wait for download to complete
        const downloadedFile = await waitForDownload(DOWNLOAD_FOLDER, 30000);
        
        if (downloadedFile) {
          console.log(`Download completed: ${downloadedFile}`);
          
          // Wait a bit more to ensure file is fully written
          await sleep(2000);
          
          // Rename the file
          await renameDownloadedPdf(profileId, DOWNLOAD_FOLDER);
        } else {
          console.log('⚠️  Download timeout - file may not have been saved');
        }
        
      } catch(e) {
        console.log('Error finding/clicking PDF button:', e.message);
        
        // Try alternative selector
        try {
          const pdfButtonAlt = await driver.findElement(
            By.xpath('//*[contains(text(), "Save to PDF")]')
          );
          await driver.executeScript("arguments[0].click();", pdfButtonAlt);
          console.log('PDF download initiated (alternative method)!');
          
          const downloadedFile = await waitForDownload(DOWNLOAD_FOLDER, 30000);
          if (downloadedFile) {
            await sleep(2000);
            await renameDownloadedPdf(profileId, DOWNLOAD_FOLDER);
          }
        } catch(e2) {
          console.log('Alternative method also failed:', e2.message);
        }
      }
      
    } catch(e) {
      console.log('Error processing profile:', e.message);
    }
  }
}

async function getProfileURLs(){
  try {
    const urlsData = await fs.readFile(profileURLsPath, 'utf8');
    let urls = urlsData.trim().split(/[\n,]+/).map(url => url.trim()).filter(url => url);
    console.log('Found URLs:', urls);
    return urls;
  } catch(e) {
    console.log('Error reading profile URLs:', e.message);
    return [];
  }
}

async function main(){
    // Create download folder
    try {
        await fs.mkdir(DOWNLOAD_FOLDER, { recursive: true });
        console.log(`📁 Download folder: ${DOWNLOAD_FOLDER}`);
    } catch(e) {
        console.log('Download folder already exists');
    }
    
    const driver = await getDriver();
    if(!driver) {
        console.log('Failed to create driver');
        return;
    }
    
    const isLogged = await loginWithSavedCookies(driver);
    if(!isLogged){
        console.log('Login failed');
        await sleep(5000);
        await driver.quit();
        return;
    }
    
    await sleep(3000);
    await proccessProfiles(driver);
    
    console.log('\n✅ All profiles processed!');
    console.log(`📁 PDFs saved in: ${DOWNLOAD_FOLDER}`);
    await sleep(5000);
    await driver.quit();
}

main();