(() => {
  const form = document.querySelector('#order-form');
  if (!form) return;
  const pages = [...document.querySelectorAll('.form-page')];
  const progress = [...document.querySelectorAll('.progress-step')];
  const fileInput = document.querySelector('#original-file');
  const verificationPriceLabel = document.querySelector('#verification-price');
  const brandInput = document.querySelector('#brand');
  const brandResults = document.querySelector('#brand-results');
  const vehicleTypeSelect = document.querySelector('#vehicle-type');
  const vehicleModelInput = document.querySelector('#vehicle-model');
  const modelSuggestions = document.querySelector('#vehicle-model-suggestions');
  const maxFileSize = 50 * 1024 * 1024;
  const maxAirbagPhotoBytes = 10 * 1024 * 1024;
  const allowedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const modulePhotoInput = document.querySelector('#airbag-module-photo');
  const partNumberPhotoInput = document.querySelector('#airbag-part-photo');
  const brands = [
    'Acura','Aixam','Alfa Romeo','Aprilia','Aston Martin','Ashok Leyland','Audi','Bajaj','BEML','Benelli','BharatBenz','Bentley','BMW','BMW Motorrad','Borgward','Bugatti','Buick','Cadillac','Caterpillar','Changan','Chery','Chevrolet','Chrysler','Citroën','CNH Industrial','Dacia','Daewoo','Daihatsu','Datsun','Dodge','Dongfeng','Ducati','Eicher','Escorts Kubota','Ferrari','Fiat','Force Motors','Ford','Foton','Geely','Genesis','GMC','Great Wall','Harley-Davidson','Higer','Hindustan Motors','Hino','HMT','Holden','Honda','Hyundai','Infiniti','Isuzu','Iveco','JAC','Jaguar','Jeep','JCB','JMC','John Deere','Kawasaki','Kia','King Long','KTM','Kubota','Lada','Lamborghini','Lancia','Land Rover','Lexus','Lifan','Lincoln','Lotus','Mahindra','Mahindra Truck and Bus','Mahindra Tractors','MAN','Maserati','Maruti Suzuki','Maserati','Mazda','McLaren','Mercedes-Benz','MG Motor','Mini','Mitsubishi','Mitsubishi Fuso','Mitsubishi Heavy Industries','Moto Guzzi','MV Agusta','New Holland','Nissan','Opel','Perodua','Peugeot','Piaggio Commercial Vehicles','Polaris','Porsche','Premier','Proton','Ram','Renault','Rolls-Royce','Roewe','Saab','Scania','Seat','Sinotruk','Skoda','SML Isuzu','Smart','Sonalika','SsangYong','Subaru','Suzuki','Swaraj','Tata Motors','Tata Motors Commercial Vehicles','TAFE','Toyota','Triumph','TVS','Vauxhall','Volkswagen','Volvo','Volvo Construction Equipment','VST Tillers Tractors','Yamaha','Yanmar','Yutong','Other / Not Listed'
  ];
  const premiumTwoWheelerBrands = new Set(['Aprilia','BMW Motorrad','Benelli','Ducati','Harley-Davidson','Kawasaki','KTM','Moto Guzzi','MV Agusta','Triumph']);
  const twoWheelerOnlyBrands = new Set(['Aprilia','Bajaj','Benelli','BMW Motorrad','Ducati','Harley-Davidson','Kawasaki','KTM','Moto Guzzi','MV Agusta','Polaris','Triumph','TVS','Yamaha']);
  const electricOnlyModels = {
    'Tata Motors':['Nexon EV','Tiago EV','Tigor EV','Punch EV','Curvv EV','Harrier EV','Sierra EV'],
    'Tata Motors Commercial Vehicles':['Ace EV'],
    'Mahindra':['XUV400','BE 6','XEV 9e','eVerito','e2o'],
    'Hyundai':['Kona','Ioniq','Ioniq 5','Ioniq 6'],
    'MG Motor':['Comet','ZS','Windsor','Cyberster'],
    'BMW':['i3','i4','i5','i7','iX','iX1','iX2','iX3'],
    'Mercedes-Benz':['EQA','EQB','EQC','EQE','EQS'],
    'Audi':['e-tron','Q4 e-tron','Q8 e-tron'],
    'Porsche':['Taycan'],
    'Volvo':['EX30','EX40','EC40','EX90'],
    'Nissan':['Leaf','Ariya'],
    'Renault':['Zoe','Megane E-Tech'],
    'Citroën':['e-C3','ë-C3','eC3'],
    'Maruti Suzuki':['e Vitara'],
    'Kia':['EV6','EV9','Carens Clavis EV'],
    'Jaguar':['I-Pace'],
    'Mini':['Cooper SE','Electric'],
    'Lexus':['RZ'],
    'Volkswagen':['ID.3','ID.4','ID.5','ID.7','ID Buzz'],
    'Ford':['Mustang Mach-E','F-150 Lightning'],
    'Toyota':['bZ4X']
  };
  function isUnsupportedElectricModel(brand, model) {
    const raw = String(model || '').trim();
    if (/\b(?:EV|BEV|electric)\b/i.test(raw)) return true;
    const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const candidate = normalize(raw);
    return (electricOnlyModels[String(brand || '').trim()] || []).some(name => {
      const blocked = normalize(name);
      return candidate === blocked || candidate.startsWith(blocked + ' ');
    });
  }
  const modelCatalog = {
    'Maruti Suzuki':['Alto','Alto K10','S-Presso','Celerio','Wagon R','Swift','Dzire','Baleno','Fronx','Brezza','Ertiga','XL6','Grand Vitara','Ignis','Eeco','Jimny','Ciaz','S-Cross','Vitara Brezza'],
    'Tata Motors':['Nano','Tiago','Tigor','Altroz','Punch','Nexon','Harrier','Safari','Indica','Indigo','Bolt','Zest','Sumo','Hexa','Aria'],
    'Tata Motors Commercial Vehicles':['Ace','Intra V10','Intra V20','Intra V30','Yodha','407','709','1109','1613','2518','Prima','Signa','Ultra','LPT','LPK','Winger'],
    'Mahindra':['Bolero','Bolero Neo','Scorpio','Scorpio-N','XUV300','XUV 3XO','XUV500','XUV700','Thar','Thar Roxx','KUV100','TUV300','Marazzo','Xylo','Quanto','Verito','Jeeto','Supro'],
    'Mahindra Truck and Bus':['Blazo','Furio','Loadking','Jayo','Bolero Pik-Up','Voyager'],
    'Mahindra Tractors':['265 DI','275 DI','575 DI','585 DI','Arjun','Yuvo','Jivo','Novo'],
    'Hyundai':['Santro','i10','Grand i10','Grand i10 Nios','i20','Accent','Verna','Aura','Xcent','Venue','Creta','Alcazar','Tucson','Santa Fe','Eon','Getz','Elantra','Sonata','Terracan','Exter'],
    'Honda':['Amaze','City','Civic','Accord','Jazz','Brio','WR-V','BR-V','CR-V','Mobilio','Elevate'],
    'Toyota':['Etios','Glanza','Urban Cruiser','Urban Cruiser Hyryder','Innova','Innova Crysta','Innova Hycross','Fortuner','Hilux','Camry','Corolla Altis','Yaris','Qualis','Land Cruiser','Vellfire'],
    'Kia':['Seltos','Sonet','Carens','Carnival'],
    'Volkswagen':['Polo','Vento','Virtus','Taigun','Tiguan','Passat','Jetta','Ameo','T-Roc'],
    'Skoda':['Fabia','Rapid','Octavia','Superb','Kushaq','Slavia','Kodiaq','Laura','Yeti'],
    'Nissan':['Micra','Sunny','Terrano','Kicks','Magnite','X-Trail'],
    'Renault':['Kwid','Triber','Kiger','Duster','Lodgy','Fluence','Pulse','Scala'],
    'Ford':['Figo','Aspire','Freestyle','EcoSport','Endeavour','Fiesta','Ikon','Mondeo','Ranger','Mustang'],
    'Chevrolet':['Spark','Beat','Sail','Aveo','Cruze','Tavera','Captiva','Enjoy','Trailblazer'],
    'Isuzu':['D-Max','V-Cross','MU-7','MU-X','S-Cab'],
    'Jeep':['Compass','Meridian','Wrangler','Grand Cherokee','Cherokee'],
    'Mercedes-Benz':['A-Class','B-Class','C-Class','E-Class','S-Class','CLA','GLA','GLB','GLC','GLE','GLS','G-Class','V-Class','Sprinter'],
    'BMW':['1 Series','2 Series','3 Series','5 Series','7 Series','X1','X3','X4','X5','X6','X7','Z4'],
    'Audi':['A3','A4','A6','A8','Q3','Q5','Q7','Q8','TT','R8'],
    'Land Rover':['Defender','Discovery','Discovery Sport','Range Rover','Range Rover Sport','Range Rover Evoque','Freelander'],
    'Volvo':['S60','S90','V40','XC40','XC60','XC90','V90'],
    'Mitsubishi':['Lancer','Cedia','Pajero','Outlander','Montero','Eclipse Cross'],
    'MG Motor':['Hector','Hector Plus','Astor','Gloster'],
    'BMW Motorrad':['S 1000 RR','M 1000 RR','R 1250 GS','R 1300 GS','F 900 GS','F 850 GS','G 310 R','G 310 GS','K 1600 GTL'],
    'Triumph':['Street Triple','Speed Triple','Bonneville T100','Bonneville T120','Tiger 900','Tiger 1200','Trident 660','Daytona 660','Speed 400','Scrambler 400 X','Rocket 3'],
    'Ducati':['Panigale V2','Panigale V4','Streetfighter V4','Monster','Multistrada V4','Diavel','Scrambler','DesertX'],
    'Kawasaki':['Ninja 300','Ninja 400','Ninja 650','Ninja ZX-6R','Ninja ZX-10R','Z650','Z900','Versys 650','Versys 1000'],
    'KTM':['Duke 390','Duke 790','Duke 890','RC 390','Adventure 390','Adventure 790','Adventure 890'],
    'Harley-Davidson':['Sportster S','Nightster','Fat Boy','Street Glide','Road Glide','Pan America','Iron 883'],
    'Aprilia':['RS 457','RS 660','RSV4','Tuono 660','Tuono V4','Tuareg 660'],
    'Benelli':['TNT 300','TNT 600i','TRK 502','Leoncino 500'],
    'Moto Guzzi':['V7','V85 TT','V100 Mandello'],
    'MV Agusta':['Brutale 800','F3 800','Dragster 800','Turismo Veloce'],
    'Ashok Leyland':['Dost','Bada Dost','Partner','Boss','Ecomet','Captain','U-Truck','Viking','Cheetah','MiTR'],
    'BEML':['BD50','BD65','BG825','BH100'],
    'BharatBenz':['914R','1017R','1217C','1417R','1617R','1923C','2523R','2823C','3528C','5528TT','School Bus'],
    'Borgward':['BX5','BX7'],
    'Chery':['Tiggo 4','Tiggo 7','Tiggo 8','Arrizo 5'],
    'CNH Industrial':['Agricultural tractor','Construction equipment'],
    'Citroën':['C3','C3 Aircross','C5 Aircross','Basalt'],
    'Dongfeng':['Light commercial truck','Heavy commercial truck','Bus'],
    'Eicher':['Pro 2049','Pro 2059','Pro 3015','Pro 3019','Pro 6028','Pro 6035','Skyline Pro','Starline'],
    'Escorts Kubota':['Farmtrac 45','Farmtrac 60','Powertrac 439','Powertrac 445','Kubota MU4501','Kubota MU5501'],
    'Fiat':['Punto','Linea','Palio','Grande Punto','Avventura','Urban Cross'],
    'Force Motors':['Traveller','Trax Cruiser','Gurkha','Urbania','Shaktiman','Kargo King'],
    'GWM':['Haval H6','Haval Jolion','Tank 300','Poer'],
    'Higer':['KLQ6119','KLQ6129','Coach / bus'],
    'Hindustan Motors':['Ambassador','Contessa'],
    'Hino':['300 Series','500 Series','700 Series'],
    'HMT':['Agricultural tractor'],
    'JAC':['N-series','T6','T8','X200'],
    'JCB':['3DX','4DX','NXT 140','JS 81','JS 205','430ZX','457ZX'],
    'JMC':['Vigus','Carrying','Conquer'],
    'John Deere':['5036 D','5045 D','5050 D','5310','5405','6110 B'],
    'King Long':['XMQ6119','XMQ6127','Coach / bus'],
    'Lada':['Niva','Granta','Vesta'],
    'Lexus':['ES','NX','RX','LX','LS','LC'],
    'Lifan':['X60','X70','Solano'],
    'MAN':['TGS','TGX','TGM','Lion’s Coach'],
    'Mitsubishi Fuso':['Canter','Fighter','Super Great','Rosa'],
    'New Holland':['3630 TX','3230 TX','4710','5630 TX Plus','T6'],
    'Porsche':['911','Cayenne','Macan','Panamera','718 Cayman','718 Boxster'],
    'Premier':['Padmini','Rio'],
    'Roewe':['RX5','i5','i6'],
    'Scania':['P-series','G-series','R-series','K-series bus'],
    'Sinotruk':['Howo light truck','Howo heavy truck'],
    'SML Isuzu':['S7','S9','Sartaj GS','Samrat GS','Prestige','Executive LX','Cosmo'],
    'Sonalika':['DI 35','DI 42','DI 47','DI 50','Tiger DI 55'],
    'Swaraj':['717','735 FE','744 FE','855 FE','963 FE'],
    'TAFE':['MF 241 DI','MF 245 DI','MF 9500','MF 1035 DI','MF 7250 DI'],
    'Volvo Construction Equipment':['EC210','EC220','EC250','L120H','L150H','A40G'],
    'Yutong':['ZK6118','ZK6122','ZK6128','Coach / bus'],
    'Other / Not Listed':[]
  };
  let currentPage = 0;
  let activeBrandOption = -1;
  let fileVerificationPricePaise = null;
  let paymentReady = false;
  let providerReadiness = { razorpay: false, paypal: false };
  let checkoutStarting = false;
  let paymentRecoveryRequired = false;
  let activeIntent = null;
  let pendingCheckoutAttemptId = null;
  let activeProvider = null;
  let razorpayScriptPromise = null;
  let fileStagedInStorage = false;
  let originalFileSha256 = '';

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function formatINR(paise) { return new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(paise / 100); }
  function setError(index, text) { const box = pages[index]?.querySelector('.form-error'); if (box) { box.textContent = text; box.classList.toggle('visible', Boolean(text)); } }
  function clearError(index) { setError(index, ''); }
  function setPage(index) { clearError(index); currentPage = index; pages.forEach((page,i)=>page.classList.toggle('active', i===index)); progress.forEach((step,i)=>step.classList.toggle('active', i<=Math.min(index,progress.length-1))); document.querySelector('.order-form')?.scrollIntoView({behavior:'smooth',block:'start'}); updateSummary(); }

  function normalizeFormData({ includeFile = true } = {}) {
    const data = new FormData(form);
    const category = String(data.get('category') || 'ECU');
    const isEcu = category === 'ECU';
    return {
      category,
      vehicleBrand: String(data.get('brand') || '').trim(), vehicleType: String(data.get('vehicleType') || '').trim(), vehicleModel: String(data.get('vehicleModel') || '').trim(), vehicleYear: String(data.get('year') || '').trim(),
      ecuManufacturer: isEcu ? String(data.get('ecuManufacturer') || '').trim() : '', ecuModel: isEcu ? String(data.get('ecuModel') || '').trim() : '', readingTool: isEcu ? String(data.get('readingTool') || '').trim() : '',
      selectedServices: data.getAll('service'), moduleDetails: category === 'AIRBAG' ? String(data.get('moduleDetails') || '').trim() : '', notes: String(data.get('notes') || '').trim(), contactName: String(data.get('name') || '').trim(), contactPhone: String(data.get('phone') || '').trim(), contactEmail: String(data.get('email') || '').trim()
    };
  }

  function validatePage(index) {
    clearError(index);
    const values = normalizeFormData({ includeFile: false });
    if (index === 1) {
      const year = values.vehicleYear;
      if (!values.vehicleBrand || !values.vehicleType || !values.vehicleModel) { setError(index, 'Brand, vehicle type and model are required.'); return false; }
      if (values.vehicleType === 'Two-wheeler' && !premiumTwoWheelerBrands.has(values.vehicleBrand)) { setError(index, 'Two-wheeler requests are limited to selected imported/premium motorcycle brands.'); return false; }
      if (isUnsupportedElectricModel(values.vehicleBrand, values.vehicleModel)) { setError(index, 'Electric vehicles are not supported. Select a supported petrol, diesel, CNG or other non-EV variant.'); return false; }
      if (values.category === 'AIRBAG' && !year) { setError(index, 'Year is required for Airbag Crash Clear requests.'); return false; }
      if (year && (!/^\d{4}$/.test(year) || Number(year)<1950 || Number(year)>2100)) { setError(index, 'Enter a valid vehicle year.'); return false; }
    }
    if (index === 2 && values.category === 'AIRBAG') {
      if (!values.moduleDetails || values.moduleDetails.length > 1200) { setError(index, 'Enter the airbag module details.'); return false; }
      for (const [input, label] of [[modulePhotoInput, 'module photo'], [partNumberPhotoInput, 'part-number photo']]) {
        const file = input?.files?.[0];
        const savedPhoto = input === modulePhotoInput ? activeIntent?.request_json?.modulePhoto : activeIntent?.request_json?.partNumberPhoto;
        if (!file && !(fileStagedInStorage && savedPhoto?.sha256)) { setError(index, `Select the required airbag ${label}.`); return false; }
        if (file && (!allowedPhotoTypes.has(file.type) || file.size < 1 || file.size > maxAirbagPhotoBytes)) { setError(index, `The airbag ${label} must be a JPG, PNG or WEBP image up to 10 MB.`); return false; }
      }
    }
    if (index === 3 && !values.selectedServices.length) { setError(index, 'Select at least one file service.'); return false; }
    if (index === 4) {
      if (!fileInput.files[0] && !fileStagedInStorage) { setError(index, 'Select your original file before continuing.'); return false; }
      if (fileInput.files[0] && fileInput.files[0].size > maxFileSize) { setError(index, 'The original file must be 50 MB or smaller.'); return false; }
      if (!values.contactName || !values.contactPhone) { setError(index, 'Your name and phone are required.'); return false; }
      if (!values.contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail)) { setError(index, 'Enter a valid email address to receive order updates.'); return false; }
          }
    if (index === 5) {
      if (!values.vehicleBrand || !values.vehicleType || !values.vehicleModel || !values.selectedServices.length) { setError(index, 'Complete the required request details before payment.'); return false; }
      if (!values.contactName || !values.contactPhone) { setError(index, 'Your name and phone are required before payment.'); return false; }
      if (values.category === 'AIRBAG' && !values.vehicleYear) { setError(index, 'Year is required for Airbag Crash Clear.'); return false; }
      if (!values.contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail)) { setError(index, 'Enter a valid email address to receive order updates.'); return false; }
      if (values.category === 'AIRBAG' && values.selectedServices.some(service => service !== 'Crash Clear')) { setError(index, 'Airbag requests support Crash Clear only.'); return false; }
    }
    return true;
  }

  function applyCategoryFields() {
    const category = String(new FormData(form).get('category') || 'ECU');
    const ecu = category === 'ECU';
    const airbag = category === 'AIRBAG';
    document.querySelectorAll('.ecu-only').forEach(el => { el.hidden = !ecu; el.querySelectorAll('input,select,textarea').forEach(control => { control.disabled = !ecu; if (!ecu) control.value = ''; }); });
    const tool = document.querySelector('.tool-field');
    if (tool) { tool.hidden = !ecu; const select = tool.querySelector('select'); if (select) { select.disabled = !ecu; if (!ecu) select.value = ''; } }
    document.querySelectorAll('.airbag-only').forEach(el => { el.hidden = !airbag; el.querySelectorAll('input,select,textarea').forEach(control => { control.disabled = !airbag; if (!airbag) control.value = ''; }); });
    document.querySelectorAll('.ecu-service-option').forEach(el => { el.hidden = airbag; const input = el.querySelector('input'); if (input) { input.disabled = airbag; if (airbag) input.checked = false; } });
    const crash = document.querySelector('.airbag-service-option');
    if (crash) { crash.hidden = !airbag; const input = crash.querySelector('input'); if (input) { input.disabled = !airbag; if (!airbag) input.checked = false; } }
    document.querySelectorAll('.airbag-review').forEach(el => { el.hidden = !airbag; });
    const thirdStep = document.querySelector('[data-page="2"]');
    if (thirdStep) { const title = thirdStep.querySelector('h3'); const intro = thirdStep.querySelector('.form-title p'); if (title && intro) { if (ecu) { title.textContent='Select ECU / module'; intro.textContent='Add the controller details and the tool used to read the file.'; } else { title.textContent='Airbag module details'; intro.textContent='Enter the module details and attach a module photo plus a clear part-number label photo.'; } } }
    const moduleLabel = document.querySelector('.progress-step:nth-of-type(5) b');
    if (moduleLabel) moduleLabel.textContent = 'Upload';
    const marker = document.querySelector('.year-required-marker');
    if (marker) marker.textContent = airbag ? '*' : 'OPTIONAL';
  }

  function updateSummary() {
    applyCategoryFields();
    const data = normalizeFormData({ includeFile:false });
    const vehicle = [data.vehicleYear,data.vehicleBrand,data.vehicleType,data.vehicleModel].filter(Boolean).join(' · ');
    const module = data.category === 'ECU' ? ([data.ecuManufacturer,data.ecuModel].filter(Boolean).join(' · ') || 'Not specified') : data.category === 'AIRBAG' ? (data.moduleDetails || 'Add airbag module details') : 'Not applicable';
    document.querySelector('.sum-category').textContent = data.category;
    document.querySelector('.review-category').textContent = data.category;
    document.querySelector('.summary-symbol').textContent = data.category === 'AIRBAG' ? '◈' : '▦';
    document.querySelector('.sum-vehicle').textContent = vehicle || 'Add vehicle details';
    document.querySelector('.sum-module').textContent = module;
    document.querySelector('.sum-services').innerHTML = data.selectedServices.length ? data.selectedServices.map(s=>`<span>${escapeHtml(s)}</span>`).join('') : '<span class="sum-empty">Choose services to see them here</span>';
    document.querySelector('.sum-file').textContent = fileInput.files[0]?.name || (fileStagedInStorage ? 'Private file already staged' : 'No file attached');
    const fee = fileVerificationPricePaise === null ? 'Price unavailable' : formatINR(fileVerificationPricePaise);
    document.querySelector('.sum-verification').textContent = fee;
    document.querySelector('.review-vehicle').textContent = vehicle || 'Add vehicle details';
    document.querySelector('.review-module').textContent = data.category === 'AIRBAG' ? 'See airbag module details below' : module;
    const airbagDetailsReview = document.querySelector('.review-airbag-details'); if (airbagDetailsReview) airbagDetailsReview.textContent = data.category === 'AIRBAG' ? (data.moduleDetails || 'Not specified') : 'Not applicable';
    const modulePhoto = modulePhotoInput?.files?.[0]; const partPhoto = partNumberPhotoInput?.files?.[0];
    const photoSummary = [modulePhoto?.name || activeIntent?.request_json?.modulePhoto?.name, partPhoto?.name || activeIntent?.request_json?.partNumberPhoto?.name].filter(Boolean).join(' · ');
    const photoReview = document.querySelector('.review-airbag-photos'); if (photoReview) photoReview.textContent = data.category === 'AIRBAG' ? (photoSummary || 'Photos not attached') : 'Not applicable';
    document.querySelector('.review-tool').textContent = data.category === 'ECU' ? (data.readingTool || 'Not specified') : 'N/A';
    document.querySelector('.review-services').textContent = data.selectedServices.join(', ') || 'Not selected';
    document.querySelector('.review-verification').textContent = fee;
    document.querySelector('.review-file').textContent = fileInput.files[0]?.name || (fileStagedInStorage ? 'Private file already staged' : 'No file attached');
    document.querySelector('.review-contact').textContent = [data.contactName,data.contactPhone,data.contactEmail].filter(Boolean).join(' · ') || 'Add contact details';
    const stagedNote = document.querySelector('.staged-file-note'); if (stagedNote) stagedNote.hidden = !fileStagedInStorage;
    updatePaymentButtons();
  }

  function brandsForCurrentVehicleType() {
    const type = String(vehicleTypeSelect?.value || '');
    if (type === 'Two-wheeler') return brands.filter(brand => premiumTwoWheelerBrands.has(brand));
    return brands.filter(brand => !twoWheelerOnlyBrands.has(brand) || brand === 'Other / Not Listed');
  }
  function renderModelSuggestions() {
    if (!modelSuggestions) return;
    const brand = String(brandInput.value || '').trim();
    const models = modelCatalog[brand] || [];
    modelSuggestions.innerHTML = models.map(model => '<option value="' + escapeHtml(model) + '"></option>').join('');
  }
  function renderBrands(query='') {
    const needle = query.trim().toLowerCase();
    const matches = brandsForCurrentVehicleType().filter(brand => !needle || brand.toLowerCase().includes(needle)).slice(0,30);
    brandResults.innerHTML = matches.map((brand,index)=>`<button type="button" class="brand-option" role="option" data-brand="${escapeHtml(brand)}" aria-selected="false">${escapeHtml(brand)}</button>`).join('');
    brandResults.classList.toggle('open', matches.length>0 && document.activeElement===brandInput);
    activeBrandOption = -1;
  }
  function closeBrandResults(){ brandResults.classList.remove('open'); brandInput.setAttribute('aria-expanded','false'); }
  brandInput.addEventListener('input',()=>{renderBrands(brandInput.value);brandInput.setAttribute('aria-expanded','true');});
  brandInput.addEventListener('focus',()=>{renderBrands(brandInput.value);brandInput.setAttribute('aria-expanded','true');});
  brandInput.addEventListener('keydown',event=>{const options=[...brandResults.querySelectorAll('.brand-option')]; if (!options.length) return; if (event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();activeBrandOption=(activeBrandOption+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options.forEach((o,i)=>o.classList.toggle('keyboard-active',i===activeBrandOption));options[activeBrandOption]?.scrollIntoView({block:'nearest'});} else if(event.key==='Enter'&&activeBrandOption>=0){event.preventDefault();options[activeBrandOption].click();} else if(event.key==='Escape') closeBrandResults();});
  brandResults.addEventListener('click',event=>{const button=event.target.closest('.brand-option');if(!button)return;pendingCheckoutAttemptId=null;brandInput.value=button.dataset.brand;closeBrandResults();renderModelSuggestions();updateSummary();});
  document.addEventListener('click',event=>{if(!event.target.closest('.brand-search-wrap'))closeBrandResults();});
  vehicleTypeSelect?.addEventListener('change',()=>{pendingCheckoutAttemptId=null;const allowed=brandsForCurrentVehicleType();if(brandInput.value && !allowed.includes(brandInput.value)){brandInput.value='';if(vehicleModelInput)vehicleModelInput.value='';}renderBrands(brandInput.value);renderModelSuggestions();updateSummary();});
  brandInput.addEventListener('change',()=>{pendingCheckoutAttemptId=null;renderModelSuggestions();});
  document.querySelectorAll('input[name="category"]').forEach(radio=>radio.addEventListener('change',()=>{document.querySelectorAll('.choice-card').forEach(card=>card.classList.toggle('selected',card.querySelector('input')?.checked));fileStagedInStorage=false;activeIntent=null;pendingCheckoutAttemptId=null;originalFileSha256='';updateSummary();}));
  document.querySelectorAll('input[name="service"],#vehicle-type,#vehicle-model,#vehicle-year,#ecu-maker,#ecu-model,#reading-tool,#customer-name,#customer-phone,#customer-email,#request-notes,#airbag-module-details').forEach(el=>el.addEventListener('input',()=>{pendingCheckoutAttemptId=null;updateSummary();}));
  document.querySelector('#original-file').addEventListener('change',()=>{fileStagedInStorage=false;activeIntent=null;pendingCheckoutAttemptId=null;originalFileSha256=''; const label=document.querySelector('.file-selected'); if(label) label.textContent=fileInput.files[0] ? `${fileInput.files[0].name} · ${formatSize(fileInput.files[0].size)}` : ''; updateSummary();});
  for (const [input, labelSelector] of [[modulePhotoInput, '.module-photo-selected'], [partNumberPhotoInput, '.part-photo-selected']]) input?.addEventListener('change',()=>{fileStagedInStorage=false;activeIntent=null;pendingCheckoutAttemptId=null;const label=document.querySelector(labelSelector);if(label)label.textContent=input.files[0]?`${input.files[0].name} · ${formatSize(input.files[0].size)}`:'';updateSummary();});
  function formatSize(bytes){return bytes<1024*1024?`${Math.max(1,Math.round(bytes/1024))} KB`:`${(bytes/(1024*1024)).toFixed(1)} MB`;}

  function loadRazorpayCheckout(timeoutMs=12000){
    if (typeof window.Razorpay === 'function') return Promise.resolve(window.Razorpay);
    if (razorpayScriptPromise) return razorpayScriptPromise;
    razorpayScriptPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else if(typeof window.Razorpay==='function')resolve(window.Razorpay);else reject(new Error('Razorpay Checkout did not load.'));};const timer=setTimeout(()=>finish(new Error('Razorpay Checkout did not load in time.')),timeoutMs);script.src='https://checkout.razorpay.com/v1/checkout.js';script.async=true;script.onload=()=>finish();script.onerror=()=>finish(new Error('Razorpay Checkout could not load.'));document.head.appendChild(script);}).catch(error=>{razorpayScriptPromise=null;throw error;});
    return razorpayScriptPromise;
  }
  async function hashFile(file){const buffer=await file.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',buffer);return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');}
  async function fetchJson(url,options={},timeoutMs=30000){const response=await fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});let result=null;try{result=await response.json();}catch{}return {response,result};}
  async function requestDataFromForm(file, savedRequest = {}) {
    const data=normalizeFormData({includeFile:false});
    const originalFile = file || null;
    const originalName = originalFile?.name || String(savedRequest.originalName || activeIntent?.original_name || '');
    const originalMime = originalFile?.type || String(savedRequest.originalMime || activeIntent?.original_mime || 'application/octet-stream');
    const originalSize = originalFile?.size || Number(savedRequest.originalSize || activeIntent?.original_size || 0);
    const originalSha256 = originalFile ? await hashFile(originalFile) : (originalFileSha256 || String(savedRequest.originalSha256 || activeIntent?.original_sha256 || ''));
    async function photoMetadata(input, saved) {
      const photo = input?.files?.[0];
      if (photo) {
        const sha256 = await hashFile(photo);
        const name = photo.name.slice(0,255);
        const reusablePath = saved && saved.name === name && saved.mime === photo.type && Number(saved.size) === photo.size && saved.sha256 === sha256 && /^content\/[a-f0-9]{64}$/.test(saved.storagePath || '');
        const storagePath = reusablePath ? saved.storagePath : `content/${[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
        return { name, mime: photo.type, size: photo.size, sha256, storagePath };
      }
      return saved && typeof saved === 'object' ? saved : null;
    }
    const modulePhoto = data.category === 'AIRBAG' ? await photoMetadata(modulePhotoInput, savedRequest.modulePhoto) : null;
    const partNumberPhoto = data.category === 'AIRBAG' ? await photoMetadata(partNumberPhotoInput, savedRequest.partNumberPhoto) : null;
    return { ...data, moduleDetails: data.category === 'AIRBAG' ? data.moduleDetails : null, modulePhoto, partNumberPhoto,
      originalName: originalName.slice(0,255), originalMime: originalMime, originalSize, originalSha256 };
  }

  function stableCheckoutData(value) {
    const data = { ...value };
    const yearText = String(data.vehicleYear ?? '').trim();
    data.vehicleYear = yearText ? Number(yearText) : null;
    for (const key of ['ecuManufacturer','ecuModel','readingTool','notes']) data[key] = data[key] ? String(data[key]).trim() : null;
    data.moduleDetails = data.category === 'AIRBAG' ? String(data.moduleDetails || '').trim() : null;
    for (const key of ['modulePhoto','partNumberPhoto']) {
      const photo = data[key];
      data[key] = data.category === 'AIRBAG' && photo ? { name:photo.name, mime:photo.mime, size:Number(photo.size), sha256:photo.sha256, storagePath:photo.storagePath } : null;
    }
    return JSON.stringify(data);
  }

  async function ensureCheckoutIntent() {
    let savedForRetry = activeIntent?.request_json || {};
    if (activeIntent?.id && fileStagedInStorage && (activeIntent.status==='FILE_STAGED'||activeIntent.status==='PAYMENT_PENDING')) {
      const current = await requestDataFromForm(null, savedForRetry);
      if (stableCheckoutData(current) === stableCheckoutData(savedForRetry)) return activeIntent;
      activeIntent = null; fileStagedInStorage = false; originalFileSha256 = ''; updateSummary();
    }
    const file=fileInput.files[0];
    if (!file) throw new Error('Select your original file before starting checkout.');
    if (file.size>maxFileSize) throw new Error('The original file must be 50 MB or smaller.');
    const backend=window.EfsiSupabase; if(!backend?.getSession()?.user?.id) throw new Error('Sign in to your customer account before payment.');
    const request=await requestDataFromForm(file, savedForRetry);
    originalFileSha256=request.originalSha256;
    if (request.category === 'AIRBAG') {
      for (const [meta, label] of [[request.modulePhoto,'module photo'],[request.partNumberPhoto,'part-number photo']]) {
        if (!meta || !meta.name || !allowedPhotoTypes.has(meta.mime) || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > maxAirbagPhotoBytes || !/^[a-f0-9]{64}$/.test(meta.sha256 || '') || !/^content\/[a-f0-9]{64}$/.test(meta.storagePath || '')) throw new Error(`Choose a valid airbag ${label} (JPG, PNG or WEBP, maximum 10 MB).`);
      }
    }
    const token=await backend.getAccessToken(); if(!token) throw new Error('Your customer session expired. Sign in again.');
    const created=await fetchJson('/api/checkout/intents',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({request,clientAttemptId:(pendingCheckoutAttemptId ||= crypto.randomUUID())})},30000);
    if(!created.response.ok) throw new Error(created.result?.error||'Secure checkout could not be saved.');
    activeIntent={id:created.result.intentId,status:created.result.status,amount_paise:created.result.amount,currency:created.result.currency,storage_path:created.result.storagePath,expires_at:created.result.expiresAt,request_sha256:created.result.requestSha256,original_sha256:request.originalSha256,original_name:file.name,original_size:file.size,request_json:request};
    const encoded=activeIntent.storage_path.split('/').map(encodeURIComponent).join('/');
    await backend.upload(`private-ecu-files/${encoded}`,file);
    if (request.category === 'AIRBAG') {
      for (const [input,meta] of [[modulePhotoInput,request.modulePhoto],[partNumberPhotoInput,request.partNumberPhoto]]) {
        if (input?.files?.[0]) await backend.upload(`private-ecu-files/${meta.storagePath}`, input.files[0]);
      }
    }
    const staged=await fetchJson(`/api/checkout/intents/${encodeURIComponent(activeIntent.id)}/stage`,{method:'POST',headers:{Authorization:`Bearer ${token}`}},30000);
    if(!staged.response.ok) throw new Error(staged.result?.error||'Private file staging could not be confirmed.');
    activeIntent={...activeIntent,status:'FILE_STAGED'};pendingCheckoutAttemptId=null;fileStagedInStorage=true;updateSummary();return activeIntent;
  }

  async function startRazorpay(intent) {
    const backend=window.EfsiSupabase; const token=await backend.getAccessToken();
    const {response,result}=await fetchJson('/api/payment/create-order',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId:intent.id})},40000);
    if(!response.ok) throw new Error(result?.error||'Razorpay checkout could not be created.');
    activeIntent={...intent,status:'PAYMENT_PENDING',payment_provider:'razorpay',provider_order_id:result.providerOrderId,payment_status:'PENDING'};
    const RazorpayCheckout=await loadRazorpayCheckout();
    const checkout=new RazorpayCheckout({key:result.keyId,amount:result.amount,currency:result.currency,order_id:result.providerOrderId,name:'ECU FILE SERVICE INDIA',description:'File Verification & Support Fee',prefill:{name:intent.request_json.contactName,email:intent.request_json.contactEmail||undefined,contact:intent.request_json.contactPhone},modal:{ondismiss:()=>{checkoutStarting=false;document.querySelector('.verification-status').textContent='Checkout closed. Your saved checkout is still available in My account.';document.querySelector('.verification-submit').disabled=false;updatePaymentButtons();}},handler:async payment=>{
      try { await verifyRazorpay(intent.id,payment); }
      catch (verificationError) {
        try {
          const token=await backend.getAccessToken();
          const recovered=await fetchJson('/api/payment/reconcile',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId:intent.id,razorpay_order_id:payment.razorpay_order_id,razorpay_payment_id:payment.razorpay_payment_id})},90000);
          if(recovered.response.ok&&recovered.result?.status==='PAID'){completeSuccess(recovered.result.orderId);return;}
          verificationError=new Error(recovered.result?.error||verificationError.message||'Payment verification is pending.');
        } catch(recoveryError) {
          verificationError=new Error(`${verificationError.message||'Payment verification failed.'} Recovery check also failed: ${recoveryError.message||'please retry later'}`);
        }
        paymentRecoveryRequired=true;checkoutStarting=false;updatePaymentButtons();
        const warning=`Razorpay returned payment details, but our server could not yet confirm the order. Do not pay again. Open My Account â†’ Saved checkouts â†’ Continue to retry recovery. Details: ${verificationError.message}`;
        document.querySelector('.verification-status').textContent=warning;setError(5,warning);
      }
    }});
    activeProvider='razorpay';checkout.open();
  }
  async function verifyRazorpay(intentId,payment){const backend=window.EfsiSupabase;const token=await backend.getAccessToken();const {response,result}=await fetchJson('/api/payment/verify',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId,razorpay_order_id:payment.razorpay_order_id,razorpay_payment_id:payment.razorpay_payment_id,razorpay_signature:payment.razorpay_signature})},90000);if(!response.ok)throw new Error(result?.error||'Payment verification failed.');if(result.status!=='PAID')throw new Error('Payment is not confirmed yet.');completeSuccess(result.orderId);}
  async function startPayPal(intent) {
    const backend=window.EfsiSupabase;const token=await backend.getAccessToken();const {response,result}=await fetchJson('/api/payment/paypal/create-order',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({intentId:intent.id})},40000);if(!response.ok)throw new Error(result?.error||'PayPal checkout could not be created.');if(!result.approvalUrl)throw new Error('PayPal did not return an approval link.');activeProvider='paypal';window.location.assign(result.approvalUrl);
  }
  async function resumePaypalReturn(){const query=new URLSearchParams(location.search);if(query.get('paypal_return')!=='1')return;const intentId=query.get('intent');const token=query.get('token');history.replaceState(null,document.title,location.pathname);if(!intentId||!token)return;const backend=window.EfsiSupabase;const session=backend?.getSession();if(!session?.user?.id){document.querySelector('.verification-status').textContent='Sign in to the account that started this PayPal checkout, then open My account to resume payment verification.';return;}try{document.querySelector('.verification-status').textContent='Confirming PayPal payment securely…';const access=await backend.getAccessToken();const {response,result}=await fetchJson('/api/payment/paypal/capture',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${access}`},body:JSON.stringify({intentId,paypalOrderId:token})},90000);if(!response.ok)throw new Error(result?.error||'PayPal payment could not be confirmed.');completeSuccess(result.orderId);}catch(error){document.querySelector('.verification-status').textContent=error.message;}}
  async function resumeFromIntent(intent){
    activeIntent=intent;
    const req=intent.request_json||{};
    const fields=[
      [['vehicleBrand','brand'],'brand'],[['vehicleType'],'vehicle-type'],[['vehicleModel'],'vehicle-model'],[['vehicleYear','year'],'vehicle-year'],
      [['ecuManufacturer'],'ecu-maker'],[['ecuModel'],'ecu-model'],[['readingTool'],'reading-tool'],[['moduleDetails'],'airbag-module-details'],
      [['notes'],'request-notes'],[['contactName','name'],'customer-name'],[['contactPhone','phone'],'customer-phone'],[['contactEmail','email'],'customer-email']
    ];
    for(const [keys,id] of fields){const el=document.getElementById(id);if(el)el.value=String(keys.map(key=>req[key]).find(value=>value!==undefined&&value!==null)??'');}
    document.querySelectorAll('input[name="category"]').forEach(r=>r.checked=r.value===req.category);
    document.querySelectorAll('.choice-card').forEach(card=>card.classList.toggle('selected',card.querySelector('input')?.checked));
    document.querySelectorAll('input[name="service"]').forEach(cb=>cb.checked=(req.selectedServices||[]).includes(cb.value));
    fileStagedInStorage=true;
    originalFileSha256=intent.original_sha256||'';
    paymentRecoveryRequired=Boolean(intent.payment_provider&&intent.provider_order_id);
    setPage(5);
    document.querySelector('.verification-status').textContent=paymentRecoveryRequired?'This checkout already has a payment reference. Recover its status from My Account before attempting another payment.':'This checkout is saved securely. Choose a payment method to continue.';
    updatePaymentButtons();updateSummary();
  }
  function completeSuccess(orderId){activeIntent=null;fileStagedInStorage=false;paymentRecoveryRequired=false;document.querySelector('.verification-submit').disabled=true;document.querySelector('.verification-status').textContent='Payment verified and your order is now available in My account.';document.querySelector('.success-state > p').textContent='Payment verified successfully. Your order and private original file are now available to our service team.';document.querySelector('.paid-order-reference').textContent=`Order reference: ${orderId}`;setPage(6);}
  function updatePaymentButtons(){const razor=document.querySelector('#pay-razorpay');const paypal=document.querySelector('#pay-paypal');if(razor)razor.disabled=!providerReadiness.razorpay||checkoutStarting||paymentRecoveryRequired;if(paypal)paypal.disabled=!providerReadiness.paypal||checkoutStarting||paymentRecoveryRequired;}
  async function beginPayment(provider){if(checkoutStarting)return;if(paymentRecoveryRequired){setError(5,'Payment recovery is required. Do not pay again; open My Account â†’ Saved checkouts â†’ Continue.');return;}if(!validatePage(5))return;if(!providerReadiness[provider]){setError(5,`${provider==='paypal'?'PayPal':'Razorpay'} is not configured yet.`);return;}const consent=form.querySelector('input[name=consent]');if(!consent?.checked){setError(5,'Please confirm you are authorised to request this service.');return;}const button=document.querySelector('.verification-submit');const status=document.querySelector('.verification-status');const backend=window.EfsiSupabase;if(!backend?.getSession()?.user?.id){setError(5,'Sign in to your customer account before payment.');return;}checkoutStarting=true;updatePaymentButtons();clearError(5);status.textContent='Saving your checkout and securely staging the original file…';try{const intent=await ensureCheckoutIntent();status.textContent=provider==='paypal'?'Opening secure PayPal approval…':'Opening secure Razorpay Checkout…';if(provider==='paypal')await startPayPal(intent);else await startRazorpay(intent);}catch(error){status.textContent=error.message||'Checkout could not be started.';setError(5,status.textContent);checkoutStarting=false;updatePaymentButtons();}}

  document.querySelectorAll('.next-button').forEach(button=>button.addEventListener('click',()=>{if(validatePage(currentPage))setPage(currentPage+1);}));
  document.querySelectorAll('.button-back').forEach(button=>button.addEventListener('click',()=>setPage(Math.max(0,currentPage-1))));
  document.querySelector('#pay-razorpay')?.addEventListener('click',()=>beginPayment('razorpay'));
  document.querySelector('#pay-paypal')?.addEventListener('click',()=>beginPayment('paypal'));
  document.querySelector('.start-over')?.addEventListener('click',()=>{form.reset();activeIntent=null;pendingCheckoutAttemptId=null;fileStagedInStorage=false;paymentRecoveryRequired=false;originalFileSha256='';document.querySelectorAll('input[name="category"]').forEach(r=>r.checked=r.value==='ECU');document.querySelectorAll('.choice-card').forEach((card,i)=>card.classList.toggle('selected',i===0));const fs=document.querySelector('.file-selected');if(fs)fs.textContent='';document.querySelector('.module-photo-selected').textContent='';document.querySelector('.part-photo-selected').textContent='';setPage(0);updateSummary();});
  window.addEventListener('efsi:resume-checkout',event=>resumeFromIntent(event.detail));
  fetch('/api/health',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(health=>{providerReadiness={razorpay:Boolean(health?.paymentReadiness?.razorpay),paypal:false};paymentReady=Boolean(health?.paymentConfigured);const status=document.querySelector('.verification-status');const gateways=document.querySelector('.payment-gateway-note');if(gateways)gateways.textContent=health?.paymentReadiness?.razorpay?'Razorpay secure checkout is available.':'Secure payment is not configured yet.';updatePaymentButtons();}).catch(()=>{paymentReady=false;updatePaymentButtons();});
  fetch('/api/pricing',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(pricing=>{if(!pricing)throw new Error('pricing');fileVerificationPricePaise=pricing.fileVerificationPricePaise;const fee=formatINR(fileVerificationPricePaise);verificationPriceLabel.textContent=fee;document.querySelectorAll('[data-fee-inline]').forEach(el=>el.textContent=fee);updateSummary();}).catch(()=>{verificationPriceLabel.textContent='Price unavailable';document.querySelector('.verification-status').dataset.error='true';document.querySelector('.verification-status').textContent='The verification fee could not be loaded. Reload and retry.';});
  document.querySelectorAll('[data-quick-category]').forEach(button => button.addEventListener('click', () => {
    const category = button.dataset.quickCategory;
    pendingCheckoutAttemptId=null;
    const radio = document.querySelector(`input[name="category"][value="${category}"]`);
    if (radio) {
      radio.checked = true;
      document.querySelectorAll('.choice-card').forEach(card => card.classList.toggle('selected', card.querySelector('input')?.checked));
      document.querySelectorAll('[data-quick-category]').forEach(option => {
        const selected = option.dataset.quickCategory === category;
        option.classList.toggle('is-selected', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
      updateSummary();
    }
  }));
  document.querySelector('.quick-module-continue')?.addEventListener('click', () => {
    document.querySelector('#order')?.scrollIntoView({behavior:'smooth', block:'start'});
    setPage(0);
  });
  const queryCategory = new URLSearchParams(location.search).get('category');
  if (queryCategory === 'ECU' || queryCategory === 'AIRBAG') {
    const requested = document.querySelector(`input[name="category"][value="${queryCategory}"]`);
    if (requested) {
      requested.checked = true;
      document.querySelectorAll('.choice-card').forEach(card=>card.classList.toggle('selected',card.querySelector('input')?.checked));
      applyCategoryFields();
      updateSummary();
      // Category links should open the form at its first step, with the requested
      // category preselected, rather than skipping "Choose module".
      if (location.hash === '#order') {
        requestAnimationFrame(() => document.querySelector('#order')?.scrollIntoView({ behavior: 'auto', block: 'start' }));
      }
    }
  }
  updateSummary();
  resumePaypalReturn();
})();

