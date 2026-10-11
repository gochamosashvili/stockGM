# Recovery Terminal: PWA (STOCK)

ტელეფონზე დასაყენებელი ვერსია. სრული ინსტრუქცია ნაბიჯ-ნაბიჯ არის ცალკე დოკუმენტში.

- `index.html`: აპი (დეშბორდი)
- `config.js`: აქ ჩაწერე Apps Script-ის მისამართი (`API_URL`)
- `runtime.js`: ფასების ჩატვირთვა, ფილტრების დამახსოვრება, ოფლაინ ქეში
- `sw.js`: ოფლაინ მუშაობა. ფაილების შეცვლისას გაზარდე `VERSION`
- `manifest.webmanifest`, `icons/`: სახელი, ფერი და ხატულა
- `data/`: S&P 500 სია, შენი სია და SEC ფინანსები (სნეპშოტი)
- `apps-script/Code.gs`: Google Apps Script-ის კოდი (GitHub-ზე ატვირთვა არ სჭირდება)
