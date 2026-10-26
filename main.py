
import jwt
import os
import json
import shutil
import random
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

# ========= الاعدادات =========
SECRET = os.environ.get("JWT_SECRET", "xy9$KL2@mn8#pq4!wr7&zt")
ALGO = "HS256"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
DATA_DIR = "data"

os.makedirs("static", exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(f"{DATA_DIR}/backups", exist_ok=True)
os.makedirs(f"{DATA_DIR}/backups/daily", exist_ok=True)

app = FastAPI(title="دفتري - نظام الاقساط")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

# ========= التخزين =========
def load_json(filename, default):
    filepath = os.path.join(DATA_DIR, filename)
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return default
    return default

def save_json(filename, data):
    filepath = os.path.join(DATA_DIR, filename)
    # نسخة احتياطية
    try:
        if os.path.exists(filepath):
            backup_name = f"{DATA_DIR}/backups/{filename.replace('.json','')}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.json"
            shutil.copy(filepath, backup_name)
    except:
        pass

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # نسخة يومية
    try:
        daily_backup = f"{DATA_DIR}/backups/daily/backup_{datetime.now().strftime('%Y-%m-%d')}.json"
        full_backup = {
            "users": load_json("users.json", {}),
            "customers": load_json("customers.json", {}),
            "notifications": load_json("notifications.json", []),
            "help_tickets": load_json("help_tickets.json", []),
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        with open(daily_backup, "w", encoding="utf-8") as f:
            json.dump(full_backup, f, ensure_ascii=False, indent=2)
    except:
        pass

users_db: Dict[str, dict] = load_json("users.json", {})
store_customers_db: Dict[str, list] = load_json("customers.json", {})
help_tickets_db: list = load_json("help_tickets.json", [])
notifications_db: list = load_json("notifications.json", [])
otp_db: Dict[str, str] = {}

# ========= الموديلات =========
class RegisterModel(BaseModel):
    first_name: str
    second_name: str
    last_name: str
    store_name: str
    phone: str
    password: str

class LoginModel(BaseModel):
    phone: str
    password: str

class OTPModel(BaseModel):
    phone: str
    code: str

class StoreCustomerModel(BaseModel):
    owner_phone: str
    customer_name: str
    customer_phone: str
    national_id: str = ""
    id_front_photo: str = ""
    id_back_photo: str = ""
    item_type: str
    total_amount: int
    monthly_installment: int
    first_payment: int = 0

class HelpTicketModel(BaseModel):
    name: str
    phone: str
    subject: str
    message: str
    owner_phone: Optional[str] = None

# ========= الصفحات الاساسية =========
@app.get("/", response_class=HTMLResponse)
def home():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return """
    <html dir="rtl" style="background:#0a0a0a;color:#FFD700;text-align:center;padding:40px;font-family:sans-serif">
    <head><title>دفتري</title></head>
    <body><h1>دفتري - نظام الاقساط</h1><p>السيرفر شغال ✅</p><p>حط ملف index.html بجانب main.py</p></body></html>
    """

@app.get("/manifest.json")
def get_manifest():
    if os.path.exists("manifest.json"):
        return FileResponse("manifest.json")
    if os.path.exists("static/manifest.json"):
        return FileResponse("static/manifest.json")
    return {"name": "دفتري", "short_name": "دفتري", "start_url": "/", "display": "standalone", "background_color": "#0a0a0a", "theme_color": "#FFD700"}

@app.get("/sw.js")
def sw():
    if os.path.exists("sw.js"):
        return FileResponse("sw.js", media_type="application/javascript")
    if os.path.exists("static/sw.js"):
        return FileResponse("static/sw.js", media_type="application/javascript")
    return FileResponse("index.html") if os.path.exists("index.html") else {"error": "not found"}

# ========= الحسابات =========
@app.post("/register")
def register(user: RegisterModel):
    if user.phone in users_db:
        return {"error": "هذا الرقم مسجل مسبقا"}
    full_name = f"{user.first_name} {user.second_name} {user.last_name}".strip()
    otp = str(random.randint(100000, 999999))
    otp_db[user.phone] = otp
    users_db[user.phone] = {
        "full_name": full_name,
        "first_name": user.first_name,
        "second_name": user.second_name,
        "last_name": user.last_name,
        "store_name": user.store_name,
        "phone": user.phone,
        "password": user.password,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    save_json("users.json", users_db)
    try:
        notif = {"id": len(notifications_db)+1, "type": "متجر جديد", "full_name": full_name, "store_name": user.store_name, "phone": user.phone, "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "read": False}
        notifications_db.append(notif)
        save_json("notifications.json", notifications_db)
    except:
        pass
    return {"message": "تم انشاء الحساب", "full_name": full_name, "store_name": user.store_name, "phone": user.phone, "otp_sent": True, "demo_otp": otp}

@app.post("/login")
def login(data: LoginModel):
    if data.phone not in users_db:
        return {"error": "الرقم غير موجود"}
    if users_db[data.phone]["password"] != data.password:
        return {"error": "كلمة السر خطأ"}
    otp = str(random.randint(100000, 999999))
    otp_db[data.phone] = otp
    print(f"### كود دخول للرقم {data.phone} هو: {otp} ###")
    return {"message": "تم ارسال كود واتساب", "otp_sent": True, "demo_otp": otp}

@app.post("/verify-otp")
def verify_otp(data: OTPModel):
    if otp_db.get(data.phone) == data.code:
        user = users_db.get(data.phone)
        token = jwt.encode({"phone": data.phone, "exp": datetime.utcnow() + timedelta(days=7)}, SECRET, algorithm=ALGO)
        return {"message": "تم التأكيد بنجاح", "success": True, "user": user, "access_token": token, "token_type": "bearer"}
    else:
        return {"error": "الكود خطأ", "success": False}

@app.post("/forgot-password")
def forgot_password(phone: str, new_password: str):
    if phone not in users_db:
        return {"error": "الرقم غير موجود"}
    otp = str(random.randint(100000, 999999))
    otp_db[phone] = otp
    users_db[phone]["password"] = new_password
    save_json("users.json", users_db)
    return {"message": "تم ارسال كود الاسترجاع", "demo_otp": otp}

@app.get("/customers")
def get_customers():
    return list(users_db.values())

# ========= الزبائن =========
@app.post("/store/add-customer")
@app.post("/kawthar/add-customer")
def add_customer(data: StoreCustomerModel):
    if data.owner_phone not in store_customers_db:
        store_customers_db[data.owner_phone] = []
    
    owner = users_db.get(data.owner_phone, {})
    store_name = owner.get("store_name", "شركتي")
    owner_name = owner.get("full_name", data.owner_phone)
    remaining = data.total_amount - data.first_payment

    customer = {
        "id": len(store_customers_db[data.owner_phone]) + 1,
        "اسم_المتجر": store_name,
        "صاحب_المتجر": owner_name,
        "اسم_الزبون": data.customer_name,
        "رقم_الزبون": data.customer_phone,
        "رقم_الهوية": data.national_id if data.national_id else "بدون",
        "صورة_وجه_الهوية": data.id_front_photo if data.id_front_photo else "بدون",
        "صورة_كفة_الهوية": data.id_back_photo if data.id_back_photo else "بدون",
        "نوع_المادة": data.item_type,
        "المبلغ_الكلي": data.total_amount,
        "القسط_الشهري": data.monthly_installment,
        "المدفوع": data.first_payment,
        "المتبقي": remaining,
        "total_amount": data.total_amount,
        "paid_amount": data.first_payment,
        "remaining": remaining,
        "monthly": data.monthly_installment,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "payments": []
    }
    if data.first_payment > 0:
        customer["payments"].append({
            "amount": data.first_payment,
            "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "before": data.total_amount,
            "after": remaining
        })
    
    store_customers_db[data.owner_phone].append(customer)
    save_json("customers.json", store_customers_db)
    return {
        "نجاح": True,
        "success": True,
        "الشركة": store_name,
        "رسالة": f"{store_name} - تم اضافه {data.customer_name}",
        "الزبون": customer,
        "المدفوع": data.first_payment,
        "المتبقي": remaining
    }

@app.get("/store/{owner_phone}/customers")
@app.get("/kawthar/{owner_phone}/customers")
def get_store_customers(owner_phone: str):
    customers = store_customers_db.get(owner_phone, [])
    total_paid = sum(c.get("المدفوع", 0) for c in customers)
    total_remaining = sum(c.get("المتبقي", 0) for c in customers)
    total_all = sum(c.get("المبلغ_الكلي", 0) for c in customers)
    return {"عدد_الزبائن": len(customers), "المبلغ_الكلي": total_all, "المدفوع_الكلي": total_paid, "المتبقي_الكلي": total_remaining, "الزبائن": customers}

@app.post("/store/{owner_phone}/customer/{customer_id}/pay")
@app.post("/kawthar/{owner_phone}/customer/{customer_id}/pay")
def pay_installment(owner_phone: str, customer_id: int, amount: int):
    if owner_phone not in store_customers_db:
        return {"error": "الشركة غير موجودة"}
    for cust in store_customers_db[owner_phone]:
        if cust["id"] == customer_id:
            old_remaining = cust.get("remaining", cust.get("المتبقي", 0))
            old_paid = cust.get("paid_amount", cust.get("المدفوع", 0))
            cust["paid_amount"] = old_paid + amount
            cust["remaining"] = cust["total_amount"] - cust["paid_amount"]
            cust["المتبقي"] = cust["remaining"]
            cust["المدفوع"] = cust["paid_amount"]
            cust["payments"].append({
                "amount": amount,
                "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
                "before": old_remaining,
                "after": cust["remaining"]
            })
            save_json("customers.json", store_customers_db)
            return {"success": True, "customer": cust, "paid": cust["paid_amount"], "remaining": cust["remaining"]}
    return {"error": "الزبون غير موجود"}

# ========= المساعدة =========
@app.post("/help/send")
def send_help_ticket(ticket: HelpTicketModel):
    new_ticket = {"id": len(help_tickets_db)+1, "name": ticket.name, "phone": ticket.phone, "subject": ticket.subject, "message": ticket.message, "owner_phone": ticket.owner_phone or "عام", "status": "جديد", "date": datetime.now().strftime("%Y-%m-%d %H:%M"), "replies": []}
    help_tickets_db.append(new_ticket)
    save_json("help_tickets.json", help_tickets_db)
    return {"نجاح": True, "رسالة": "تم ارسال رسالتك"}

@app.get("/help/tickets")
def get_all_tickets():
    return {"عدد_الرسائل": len(help_tickets_db), "الرسائل": help_tickets_db}

# ========= الادمن =========
@app.get("/admin/notifications")
def get_admin_notifications(password: str = ""):
    unread = len([n for n in notifications_db if not n.get("read", False)])
    if password != ADMIN_PASSWORD:
        return {"عدد_الاشعارات_غير_المقروءة": unread, "تحتاج_باسورد": True}
    return {"عدد_الاشعارات": len(notifications_db), "غير_مقروءة": unread, "الاشعارات": list(reversed(notifications_db))}

@app.get("/admin/stats")
def get_admin_stats(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    total_stores = len(users_db)
    total_customers = sum(len(v) for v in store_customers_db.values())
    total_paid = sum(sum(c.get("المدفوع", 0) for c in v) for v in store_customers_db.values())
    total_remaining = sum(sum(c.get("المتبقي", 0) for c in v) for v in store_customers_db.values())
    return {"عدد_المتاجر": total_stores, "عدد_الزبائن_الكلي": total_customers, "المدفوع_الكلي": total_paid, "المتبقي_الكلي": total_remaining}

@app.get("/admin/stores")
def get_all_stores_admin(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد الادمن خطأ"}
    stores = []
    for phone, user in users_db.items():
        customers = store_customers_db.get(phone, [])
        stores.append({
            "رقم_المالك": phone,
            "اسم_المتجر": user.get("store_name"),
            "اسم_المالك": user.get("full_name"),
            "عدد_الزبائن": len(customers),
            "المبلغ_الكلي": sum(c.get("المبلغ_الكلي", 0) for c in customers),
            "المدفوع_الكلي": sum(c.get("المدفوع", 0) for c in customers),
            "المتبقي_الكلي": sum(c.get("المتبقي", 0) for c in customers),
            "الزبائن_بالتفصيل": [{"اسم_الزبون": c.get("اسم_الزبون"), "المبلغ_الكلي": c.get("المبلغ_الكلي"), "المدفوع": c.get("المدفوع"), "المتبقي": c.get("المتبقي")} for c in customers]
        })
    return {"عدد_المتاجر": len(stores), "المتاجر": stores}

@app.get("/admin/store/{store_phone}")
def get_store_details(store_phone: str, password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد الادمن خطأ"}
    if store_phone not in users_db:
        return {"error": "المتجر غير موجود"}
    user = users_db[store_phone]
    customers = store_customers_db.get(store_phone, [])
    return {
        "اسم_المتجر": user.get("store_name"),
        "اسم_المالك": user.get("full_name"),
        "رقم_المالك": store_phone,
        "عدد_الزبائن": len(customers),
        "المبلغ_الكلي": sum(c.get("المبلغ_الكلي", 0) for c in customers),
        "المدفوع_الكلي": sum(c.get("المدفوع", 0) for c in customers),
        "المتبقي_الكلي": sum(c.get("المتبقي", 0) for c in customers),
        "الزبائن": customers
    }

@app.get("/admin/export/excel")
def export_excel(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    try:
        import pandas as pd
        stores_data = []
        for phone, user in users_db.items():
            customers = store_customers_db.get(phone, [])
            stores_data.append({
                "رقم المالك": phone,
                "اسم المتجر": user.get("store_name"),
                "اسم المالك": user.get("full_name"),
                "عدد الزبائن": len(customers),
                "المبلغ الكلي": sum(c.get("المبلغ_الكلي", 0) for c in customers),
                "المدفوع الكلي": sum(c.get("المدفوع", 0) for c in customers),
                "المتبقي الكلي": sum(c.get("المتبقي", 0) for c in customers)
            })
        customers_data = []
        for owner_phone, customers in store_customers_db.items():
            owner = users_db.get(owner_phone, {})
            for c in customers:
                customers_data.append({
                    "رقم مالك المتجر": owner_phone,
                    "اسم المتجر": owner.get("store_name", ""),
                    "اسم الزبون": c.get("اسم_الزبون"),
                    "رقم الزبون": c.get("رقم_الزبون"),
                    "نوع المادة": c.get("نوع_المادة"),
                    "المبلغ الكلي": c.get("المبلغ_الكلي"),
                    "المدفوع": c.get("المدفوع"),
                    "المتبقي": c.get("المتبقي")
                })
        os.makedirs("data/exports", exist_ok=True)
        with pd.ExcelWriter("data/exports/المتاجر_والزبائن.xlsx", engine="openpyxl") as writer:
            pd.DataFrame(stores_data).to_excel(writer, sheet_name="المتاجر", index=False)
            pd.DataFrame(customers_data).to_excel(writer, sheet_name="الزبائن", index=False)
        return FileResponse("data/exports/المتاجر_والزبائن.xlsx", filename="دفتري_المتاجر_والزبائن.xlsx", media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    except Exception as e:
        return {"error": str(e), "حل": "pip install pandas openpyxl"}

@app.get("/admin/export/json")
def export_json(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    os.makedirs("data/exports", exist_ok=True)
    export = {"المتاجر": users_db, "الزبائن": store_customers_db, "الاشعارات": notifications_db, "تذاكر_المساعدة": help_tickets_db, "تاريخ_التصدير": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    with open("data/exports/تصدير_كامل.json", "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)
    return FileResponse("data/exports/تصدير_كامل.json", filename="دفتري_تصدير_كامل.json")

@app.get("/admin/backups/list")
def list_backups(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    backups = []
    for root, dirs, files in os.walk(f"{DATA_DIR}/backups"):
        for file in files:
            path = os.path.join(root, file)
            backups.append({"الملف": path, "الحجم": os.path.getsize(path), "التاريخ": datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M:%S")})
    return {"عدد_النسخ": len(backups), "النسخ": sorted(backups, key=lambda x: x["التاريخ"], reverse=True)}

@app.get("/admin/backup/download")
def download_backup(password: str = "", file: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    if file and os.path.exists(file):
        return FileResponse(file, filename=os.path.basename(file))
    all_files = []
    for root, dirs, files in os.walk(f"{DATA_DIR}/backups"):
        for f in files:
            all_files.append(os.path.join(root, f))
    if not all_files:
        return {"error": "لا توجد نسخ"}
    latest = sorted(all_files, key=lambda x: os.path.getmtime(x), reverse=True)[0]
    return FileResponse(latest, filename=os.path.basename(latest))

@app.get("/health")
def health_check():
    return {"status": "ok", "app": "دفتري", "version": "2.0.0", "stores": len(users_db), "customers": sum(len(v) for v in store_customers_db.values())}

# ========= تشغيل =========
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"=== دفتري يشتغل على http://localhost:{port} ===")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
