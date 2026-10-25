import jwt 
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware 
from fastapi.staticfiles import StaticFiles 
from fastapi.responses import HTMLResponse, FileResponse 
from pydantic import BaseModel
from typing import Dict, List, Optional
import random, os, json, shutil
from datetime import datetime, timedelta
SECRET = "xy9$KL2@mn8#pq4 ! wr7&zt"
ALGO="HS256"

app = FastAPI(title="دفتري - نظام الاقساط")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
os.makedirs("static", exist_ok=True)
os.makedirs("data", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

DATA_DIR = "data"

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
    # نسخة احتياطية قبل الحفظ - نحتفظ بكل النسخ للابد - نحتفظ بكل النسخ بدون حذف
    try:
        if os.path.exists(filepath):
            os.makedirs("data/backups", exist_ok=True)
            backup_name = f"data/backups/{filename.replace('.json','')}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.json"
            shutil.copy(filepath, backup_name)
    except:
        pass
            # ما نمسح شي - نحتفظ بكل النسخ للابد
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # نسخة احتياطية يومية كاملة
    try:
        os.makedirs("data/backups/daily", exist_ok=True)
        daily_backup = f"data/backups/daily/backup_{datetime.now().strftime('%Y-%m-%d')}.json"
        full_backup = {
            "users": load_json ("users.json",{}),
             "customers": load_json ("customers.json",{}),
            "notifications": load_json ("notifications.json",[]),
            "help_tickets": load_json ("help_tickets.json",[]),
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        with open(daily_backup, "w", encoding="utf-8") as f:
             json.dump(full_backup, f, ensure_ascii=False, indent=2)
    except:
     pass

users_db: Dict[str, dict] = load_json("users.json", {})
otp_db: Dict[str, str] = {}
store_customers_db: Dict[str, list]= load_json("customers.json", {})
help_tickets_db: list[dict] = load_json("help_tickets.josn",[])
notifications_db: list [dict]= load_json("notifications.json",[])

ADMIN_PASSWORD = "admin123"

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
    owner_phone: str  # رقم صاحب المتجر
    customer_name: str
    customer_phone: str
    national_id: str = ""
    id_front_photo: str = ""  # صورة وجه - اختياري + زر تخطي
    id_back_photo: str = ""  # صورة كفة - اختياري + زر تخطي
    item_type: str  # النوع هو بكنبه نكيمه: ثلاجة، غسالة، فرن، اي شي
    total_amount: int  # المبلغ الكلي هو بكنبه نكيمه: اي مبلغ يريده
    monthly_installment: int  # القسط هو بكنبه نكيمه: اي مبلغ يريده
    first_payment: int = 0  # اول دفعه - هو يكنسها بكيفه


class HelpTicketModel(BaseModel):
    name: str
    phone: str
    subject: str
    message: str
    owner_phone: Optional[str] = None

@app.get("/")
def home():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return """
    <html dir="rtl" style="background:#0a0a0a;color:#FFD700;text-align:center;padding:40px">
    <head><title>دفتري</title><link rel="icon" href="/static/icon.png"><link rel="manifest" href="/manifest.json"></head>
    <body><img src="/static/icon.png" class="w-20 h-20 rounded-2xl"><h1>دفتري - نظام الاقساط</h1><p>السيرفر شغال ✅</p></body></html>
    """

@app.get("/manifest.json")
def get_manifest():
    from fastapi.responses import FileResponse
    if os.path.exists("manifest.json"):
        return FileResponse("manifest.json")
    if os.path.exists("static/manifest.json"):
        return FileResponse("static/manifest.json")
    return {"error": "manifest not found"}

    @app.get("/sw.js")
def sw():
    if os.path.exists("sw.js"):
        return FileResponse("sw.js", media_type="application/javascript")
    return {"error": "not found"}

@app.get("/manifest.json")
def manifest():
    if os.path.exists("manifest.json"):
        return FileResponse("manifest.json")
    if os.path.exists("static/manifest.json"):
        return FileResponse("static/manifest.json")
    return {"name": "دفتري"}
    
    <html dir="rtl" style="background:#0a0a0a;color:#FFD700;text-align:center;padding:40px">
    <head>
        <title>دفتري</title>
        <link rel="icon" href="/static/icon.png">
        <link rel="manifest" href="/manifest.json">
    </head>
    <body>
        <img src="/static/icon.png" class="w-20 h-20 rounded-2xl">
        <h1>دفتري - نظام الاقساط</h1>
        <p>السيرفر شغال ✅</p>
    </body>
    </html>
    """

@app.post("/register")
def register(user: RegisterModel):
    if user.phone in users_db:
        return {"error": "هذا الرقم مسجل مسبقا"}
    full_name = f"{user.first_name} {user.second_name} {user.last_name}"
    otp = str(random.randint(100000, 999999))
    otp_db[user.phone] = otp
    users_db[user.phone] = {"full_name": full_name, "first_name": user.first_name, "second_name": user.second_name, "last_name": user.last_name, "store_name": user.store_name, "phone": user.phone, "password": user.password}
    save_json("users.json", users_db)
    # اشعار للادمن
  
    try: 
       notif = {"id": len(notifications_db)+1, "type": "متجر جديد", "full_name": full_name, "store_name": user.store_name, "phone": user.phone, "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "read": False}
       notifications_db.append(notif)
       save_json("notifications.json", notifications_db)
       print(f"🔔 متجر جديد! {user.store_name} - {full_name} - {user.phone}")
    except: pass
    return {"message": "تم انشاء الحساب", "full_name": full_name, "store_name": user.store_name, "phone": user.phone, "otp_sent": True, "demo_otp": otp}

@app.post("/login")
def login(data: LoginModel):
    if data.phone not in users_db:
        return {"error": "الرقم غير موجود"}
    if users_db[data.phone]["password"]!= data.password:
        return {"error": "كلمة السر خطأ"}
    otp = str(random.randint(100000, 999999))
    otp_db[data.phone] = otp
    print(f"### كود دخول واتساب للرقم {data.phone} هو: {otp} ###")
    return {"message": "تم ارسال كود واتساب", "otp_sent": True, "demo_otp": otp}

@app.post("/verify-otp")
def verify_otp(data: OTPModel):
    if otp_db.get(data.phone) == data.code:
        user = users_db.get(data.phone)
        import jwt
        import datetime
        token = jwt.encode ({"phone":data.phone, "exp": datetime.datetime.utcnow()+datetime.timedelta(days=7)},"xy9$KL2@mn8#pq4 ! wr7&zt",algorithm= "HS256")
        return {"message": "تم التأكيد بنجاح", "success": True, "user": user, "access_token":token,"token_type":"bearer"}
    else:
     return {"error": "الكود خطأ", "success": False}

@app.post("/forgot-password")
def forgot_password(phone: str, new_password: str):
    if phone not in users_db:
        return {"error": "الرقم غير موجود"}
    otp = str(random.randint(100000, 999999))
    otp_db[phone] = otp
    print(f"### كود استرجاع واتساب للرقم {phone} هو: {otp} ###")
    users_db[phone]["password"] = new_password
    return {"message": "تم ارسال كود الاسترجاع على واتساب", "demo_otp": otp}

@app.get("/customers")
def get_customers():
     return list(users_db.values())

@app.post("/store/add-customer")
@app.post("/kawthar/add-customer") 
def add_kawthar_customer(data: StoreCustomerModel):
    if data.owner_phone not in store_customers_db:
      store_customers_db[data.owner_phone] = []
      remaining = data.total_amount - data.first_payment
    new_id = len(store_customers_db[data.owner_phone]) + 1
    customer = {"الرقم": new_id, "اسم_الزبون": data.customer_name, "رقم_الزبون": data.customer_phone, "نوع_المادة": data.item_type, "المبلغ_الكلي": data.total_amount, "المدفوع": data.first_payment, "المتبقي": remaining}
    store_customers_db[data.owner_phone].append(customer)
    save_json("customers.json", store_customers_db)
    return {"نجاح": True, "الزبون": customer}
    owner = users_db.get(data.owner_phone, {})
    store_name = owner.get("store_name", "شركتي")
    owner_name = owner.get("full_name", data.owner_phone)
    remaining = data.total_amount - data.first_payment

    ustomer = {
        "id": len(store_customers_db[data.owner_phone]) + 1,
        "اسم_المتجر": store_name,
        "صاحب_المتجر": owner_name,
        "اسم_الزبون": data.customer_name,
        "رقم_الزبون": data.customer_phone,
        "رقم_الهوية": data.national_id if data.national_id else "بغضل",
        "صورة_وجه_الهوية": data.id_front_photo if data.id_front_photo else "بغضل",
        "صورة_كفة_الهوية": data.id_back_photo if data.id_back_photo else "بغضل",
        "نوع_المادة": data.item_type,
        "المبلغ_الكلي": data.total_amount,
        "القسط_الشهري": data.monthly_installment,
        "المدفوع": data.first_payment,
        "المبلغ_المتبقي": remaining,
        "total_amount": data.total_amount,
        "paid_amount": data.first_payment,
        "remaining": remaining,
        "monthly": data.monthly_installment,
        "created_at": "اليوم",
        "payments": []
    }
    if data.first_payment > 0:
        customer["payments"].append({
            "القسط": 1,
            "المبلغ": data.first_payment,
            "المتبقي": remaining
        })
    
    store_customers_db[data.owner_phone].append(customer)
    save_json("customers.json", store_customers_db)
    return {
    "نجاح": True,
    "success": True,
"الشركة": store_name,   
"رسالة": f"{store_name} - تم اضافه {data.customer_name} - {data.item_type}",
"مثلا": f"{data.total_amount} - {data.firt_payment} = {remaining}",
"الزبون": customer ,
"المدفوع": data.first_payment ,
"المتبقي": remaining
  }

@app.post("/store/{owner_phone}/customer/{customer_id}/pay")
@app.post("/kawthar/{owner_phone}/customers")
@app.get("/store/{owner_phone}/customers")
def get_store_customers(owner_phone: str):
    customers = store_customers_db.get(owner_phone, [])
    total_paid = sum(c.get("المدفوع",0) for c in customers)
    total_remaining = sum(c.get("المتبقي",0) if c.get("المتبقي") is not None else c.get("المبلغ_المتبقي",0) for c in customers)
    total_all = sum(c.get("المبلغ_الكلي",0) for c in customers)
    return {"عدد_الزبائن": len(customers), "المبلغ_الكلي": total_all, "المدفوع_الكلي": total_paid, "المتبقي_الكلي": total_remaining, "الزبائن": customers}
@app.post("/store/{owner_phone}/customer/{customer_id}/pay")
@app.post("/kawthar/{owner_phone}/customer/{customer_id}/pay")
def pay_kawthar(owner_phone: str, customer_id: int, amount: int):
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
            
            return {
                "success": True,
                "customer": cust,
                "paid": cust["paid_amount"],
                "remaining": cust["remaining"]
            }
    
    return {"error": "customer not found"}

    
app.post("/help/send")
def send_help_ticket(ticket: HelpTicketModel):
    new_ticket = {"id": len(help_tickets_db) + 1, "name": ticket.name, "phone": ticket.phone, "subject": ticket.subject, "message": ticket.message, "owner_phone": ticket.owner_phone or "عام", "status": "جديد", "date": datetime.now().strftime("%Y-%m-%d %H:%M"), "replies": []}
    help_tickets_db.append(new_ticket)
    save_json("help_tickets.json", help_tickets_db)
    return {"نجاح": True, "رسالة": "تم ارسال رسالتك"}

@app.get("/help/tickets")
def get_all_tickets():
    return {"عدد_الرسائل": len(help_tickets_db), "الرسائل": help_tickets_db}

    @app.get("/help/tickets")
    def get_all_tickets():
            return {"عدد_الرسائل": len(help_tickets_db), "الرسائل": help_tickets_db}

# ================== الادمن - كلشي عن المتاجر ==================
@app.get("/admin/notifications")
def get_admin_notifications(password: str = ""):
    unread = len([n for n in notifications_db if not n.get("read", False)])
    if password != ADMIN_PASSWORD:
        return {"عدد_الاشعارات_غير_المقروءة": unread, "تحتاج_باسورد": True}
    return {"عدد_الاشعارات": len(notifications_db), "غير_مقروءة": unread, "الاشعارات": list(reversed(notifications_db))}

@app.get("/admin/stores")
def get_all_stores_admin(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد الادمن خطأ"}
    stores = []
    for phone, user in users_db.items():
        customers = store_customers_db.get(phone, [])
        total_customers = len(customers)
        total_remaining = sum(c.get("المتبقي", 0) for c in customers)
        total_paid = sum(c.get("المدفوع", 0) for c in customers)
        total_all = sum(c.get("المبلغ_الكلي", 0) for c in customers)
        stores.append({
            "رقم_المالك": phone,
            "اسم_المتجر": user.get("store_name"),
            "اسم_المالك": user.get("full_name"),
            "عدد_الزبائن": total_customers,
            "المبلغ_الكلي": total_all,
            "المدفوع_الكلي": total_paid,
            "المتبقي_الكلي": total_remaining,
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
    detailed = []
    for c in customers:
        perc = round((c.get("المدفوع",0)/c.get("المبلغ_الكلي",1)*100),1) if c.get("المبلغ_الكلي",0)>0 else 0
        detailed.append({
            "اسم_الزبون": c.get("اسم_الزبون"),
            "رقم_الزبون": c.get("رقم_الزبون"),
            "نوع_المادة": c.get("نوع_المادة"),
            "المبلغ_الكلي": c.get("المبلغ_الكلي"),
            "المدفوع": c.get("المدفوع"),
            "المتبقي": c.get("المتبقي"),
            "نسبة_الدفع": f"{perc}%"
        })
    return {
        "اسم_المتجر": user.get("store_name"),
        "اسم_المالك": user.get("full_name"),
        "رقم_المالك": store_phone,
        "عدد_الزبائن": len(customers),
        "المبلغ_الكلي": sum(c.get("المبلغ_الكلي",0) for c in customers),
        "المدفوع_الكلي": sum(c.get("المدفوع",0) for c in customers),
        "المتبقي_الكلي": sum(c.get("المتبقي",0) for c in customers),
        "الزبائن": detailed
    }

@app.get("/admin/stats")
def get_admin_stats(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    total_stores = len(users_db)
    total_customers = sum(len(v) for v in store_customers_db.values())
    total_paid = sum(sum(c.get("المدفوع",0) for c in v) for v in store_customers_db.values())
    total_remaining = sum(sum(c.get("المتبقي",0) for c in v) for v in store_customers_db.values())
    return {
        "عدد_المتاجر": total_stores,
        "عدد_الزبائن_الكلي": total_customers,
        "المدفوع_الكلي": total_paid,
        "المتبقي_الكلي": total_remaining
    }

@app.get("/admin/export/excel")
def export_excel(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    try:
        import pandas as pd
        from fastapi.responses import FileResponse
        
        # ملف 1: كل المتاجر
        stores_data = []
        for phone, user in users_db.items():
            customers = store_customers_db.get(phone, [])
            stores_data.append({
                "رقم المالك": phone,
                "اسم المتجر": user.get("store_name"),
                "اسم المالك": user.get("full_name"),
                "الاسم الاول": user.get("first_name"),
                "الاسم الثاني": user.get("second_name"),
                "الاسم الاخير": user.get("last_name"),
                "تاريخ التسجيل": user.get("created_at",""),
                "عدد الزبائن": len(customers),
                "المبلغ الكلي": sum(c.get("المبلغ_الكلي",0) for c in customers),
                "المدفوع الكلي": sum(c.get("المدفوع",0) for c in customers),
                "المتبقي الكلي": sum(c.get("المتبقي",0) for c in customers)
            })
        
        # ملف 2: كل الزبائن بالتفصيل
        customers_data = []
        for owner_phone, customers in store_customers_db.items():
            owner = users_db.get(owner_phone, {})
            for c in customers:
                customers_data.append({
                    "رقم مالك المتجر": owner_phone,
                    "اسم المتجر": owner.get("store_name",""),
                    "اسم مالك المتجر": owner.get("full_name",""),
                    "رقم الزبون": c.get("الرقم"),
                    "اسم الزبون": c.get("اسم_الزبون"),
                    "رقم هاتف الزبون": c.get("رقم_الزبون"),
                    "نوع المادة": c.get("نوع_المادة"),
                    "المبلغ الكلي": c.get("المبلغ_الكلي"),
                    "المدفوع": c.get("المدفوع"),
                    "المتبقي": c.get("المتبقي"),
                    "نسبة الدفع": f"{round(c.get('المدفوع',0)/c.get('المبلغ_الكلي',1)*100,1)}%" if c.get("المبلغ_الكلي",0)>0 else "0%"
                })
        
        os.makedirs("data/exports", exist_ok=True)
        
        # حفظ كـ Excel
        with pd.ExcelWriter("data/exports/المتاجر_والزبائن.xlsx", engine="openpyxl") as writer:
            pd.DataFrame(stores_data).to_excel(writer, sheet_name="المتاجر", index=False)
            pd.DataFrame(customers_data).to_excel(writer, sheet_name="الزبائن بالتفصيل", index=False)
            pd.DataFrame(list(reversed(notifications_db))).to_excel(writer, sheet_name="الاشعارات", index=False)
        
        # حفظ كـ CSV ايضا
        pd.DataFrame(stores_data).to_csv("data/exports/المتاجر.csv", index=False, encoding="utf-8-sig")
        pd.DataFrame(customers_data).to_csv("data/exports/الزبائن.csv", index=False, encoding="utf-8-sig")
        
        return FileResponse("data/exports/المتاجر_والزبائن.xlsx", filename="دفتري_المتاجر_والزبائن.xlsx", media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    except Exception as e:
        return {"error": str(e), "حل": "pip install pandas openpyxl"}

@app.get("/admin/export/json")
def export_json(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    os.makedirs("data/exports", exist_ok=True)
    export = {
        "المتاجر": users_db,
        "الزبائن": store_customers_db,
        "الاشعارات": notifications_db,
        "تذاكر_المساعدة": help_tickets_db,
        "تاريخ_التصدير": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    with open("data/exports/تصدير_كامل.json", "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)
    return FileResponse("data/exports/تصدير_كامل.json", filename="دفتري_تصدير_كامل.json")

@app.get("/admin/files")
def list_admin_files(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    files = []
    for root, dirs, filenames in os.walk("data"):
        for filename in filenames:
            path = os.path.join(root, filename)
            files.append({
                "الملف": path,
                "الحجم": os.path.getsize(path),
                "تاريخ": datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M")
            })
    return {"الملفات_المحفوظة": files}

@app.get("/admin/dashboard", response_class=HTMLResponse)
def admin_dashboard():
    return """
    <html dir="rtl" style="background:#0a0a0a;color:#FFD700;font-family:sans-serif;padding:20px">
    <head><title>لوحة تحكم الادمن - دفتري</title><link rel="icon" href="/static/icon.png"><script src="https://cdn.tailwindcss.com"></script></head>
    <body>
        <div class="max-w-4xl mx-auto">
            <div class="text-center py-6">
                <img src="/static/icon.png" class="w-20 h-20 rounded-2xl mx-auto border-2 border-yellow-500">
                <h1 class="text-3xl font-black mt-4">لوحة تحكم الادمن 👑</h1>
                <p class="text-gray-400">دفتري - كل المتاجر والزبائن</p>
            </div>
            
            <div class="bg-[#111] border-2 border-yellow-500 rounded-2xl p-6 mb-6">
                <h3 class="font-bold text-xl mb-4">ادخل باسورد الادمن</h3>
                <input id="pass" type="password" placeholder="الباسورد: admin123" class="w-full p-3 rounded-xl bg-[#050505] border border-yellow-500 text-yellow-400 mb-3">
                <button onclick="loadStats()" class="w-full bg-yellow-500 text-black p-3 rounded-xl font-bold">دخول</button>
            </div>
            
            <div id="stats" class="hidden">
                <div class="grid grid-cols-2 gap-4 mb-6">
                    <div class="bg-[#111] border border-yellow-500/30 rounded-xl p-4 text-center"><p class="text-gray-400 text-sm">عدد المتاجر</p><p id="storeCount" class="text-2xl font-black">0</p></div>
                    <div class="bg-[#111] border border-yellow-500/30 rounded-xl p-4 text-center"><p class="text-gray-400 text-sm">عدد الزبائن</p><p id="custCount" class="text-2xl font-black">0</p></div>
                    <div class="bg-[#111] border border-yellow-500/30 rounded-xl p-4 text-center"><p class="text-gray-400 text-sm">المدفوع الكلي</p><p id="paid" class="text-2xl font-black">0</p></div>
                    <div class="bg-[#111] border border-yellow-500/30 rounded-xl p-4 text-center"><p class="text-gray-400 text-sm">المتبقي الكلي</p><p id="remain" class="text-2xl font-black">0</p></div>
                </div>
                
                <div class="bg-[#111] border-2 border-yellow-500 rounded-2xl p-6 mb-6">
                    <h3 class="font-bold text-xl mb-4">تحميل الملفات 📁</h3>
                    <div class="grid gap-3">
                        <a id="excelLink" href="#" class="block bg-green-600 text-white p-3 rounded-xl text-center font-bold">📊 تحميل Excel (المتاجر + الزبائن + المدفوع)</a>
                        <a id="jsonLink" href="#" class="block bg-blue-600 text-white p-3 rounded-xl text-center font-bold">📄 تحميل JSON كامل</a>
                        <a id="storesLink" href="#" class="block bg-[#FFD700] text-black p-3 rounded-xl text-center font-bold">🏪 عرض كل المتاجر وعدد زبائنها</a>
                    </div>
                </div>
                
                <div id="storesList" class="space-y-3"></div>
            </div>
        </div>
        
        <script>
        let pwd = "";
        async function loadStats(){
            pwd = document.getElementById('pass').value;
            if(!pwd){alert('ادخل الباسورد');return;}
            try{
                const res = await fetch(`/admin/stats?password=${pwd}`);
                const data = await res.json();
                if(data.error){alert(data.error);return;}
                document.getElementById('stats').classList.remove('hidden');
                document.getElementById('storeCount').innerText = data['عدد_المتاجر'];
                document.getElementById('custCount').innerText = data['عدد_الزبائن_الكلي'];
                document.getElementById('paid').innerText = data['المدفوع_الكلي'] + ' د.ع';
                document.getElementById('remain').innerText = data['المتبقي_الكلي'] + ' د.ع';
                
                document.getElementById('excelLink').href = `/admin/export/excel?password=${pwd}`;
                document.getElementById('jsonLink').href = `/admin/export/json?password=${pwd}`;
                document.getElementById('storesLink').href = `/admin/stores?password=${pwd}`;
                
                loadStores();
            }catch(e){alert(e)}
        }
        async function loadStores(){
            const res = await fetch(`/admin/stores?password=${pwd}`);
            const data = await res.json();
            const div = document.getElementById('storesList');
            div.innerHTML = data['المتاجر'].map(s => `
                <div class="bg-[#111] border border-yellow-500/40 rounded-2xl p-4">
                    <div class="flex justify-between"><span class="font-bold">${s['اسم_المتجر']} - ${s['اسم_المالك']}</span><span class="bg-yellow-500 text-black px-2 py-1 rounded text-xs">${s['عدد_الزبائن']} زبون</span></div>
                    <p class="text-gray-400 text-sm mt-1">${s['رقم_المالك']}</p>
                    <div class="flex gap-2 mt-2 text-xs">
                        <span class="bg-[#050505] px-2 py-1 rounded">الكلي: ${s['المبلغ_الكلي']}</span>
                        <span class="bg-green-900 px-2 py-1 rounded">المدفوع: ${s['المدفوع_الكلي']}</span>
                        <span class="bg-red-900 px-2 py-1 rounded">المتبقي: ${s['المتبقي_الكلي']}</span>
                    </div>
                    <div class="mt-3">
                        ${s['الزبائن_بالتفصيل'].map(c => `<div class="flex justify-between text-xs bg-[#050505] p-2 rounded mt-1"><span>${c['اسم_الزبون']}</span><span>المدفوع: ${c['المدفوع']} / الكلي: ${c['المبلغ_الكلي']}</span></div>`).join('')}
                    </div>
                </div>
            `).join('');
        }
        </script>
    </body>
    </html>
    """

@app.get("/admin/backup")
def create_backup(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    try:
        os.makedirs("data/backups", exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        backup_file = f"data/backups/backup_full_{timestamp}.json"
        full = {
            "المتاجر": users_db,
            "الزبائن": store_customers_db,
            "الاشعارات": notifications_db,
            "المساعدة": help_tickets_db,
            "تاريخ_النسخة": timestamp
        }
        with open(backup_file, "w", encoding="utf-8") as f:
            json.dump(full, f, ensure_ascii=False, indent=2)
        return {"نجاح": True, "ملف_النسخة": backup_file, "الحجم": os.path.getsize(backup_file)}
    except Exception as e:
        return {"error": str(e)}

@app.get("/admin/backups/list")
def list_backups(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    backups = []
    for root, dirs, files in os.walk("data/backups"):
        for file in files:
            path = os.path.join(root, file)
            backups.append({"الملف": path, "الحجم": os.path.getsize(path), "التاريخ": datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M:%S")})
    return {"عدد_النسخ": len(backups), "النسخ": sorted(backups, key=lambda x: x["التاريخ"], reverse=True)}

@app.get("/admin/backup/download")
def download_backup(password: str = "", file: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    if not file or not os.path.exists(file):
        # احدث نسخة
        backups = []
        for root, dirs, files in os.walk("data/backups"):
            for f in files:
                backups.append(os.path.join(root, f))
        if not backups:
            return {"error": "لا توجد نسخ"}
        file = sorted(backups, key=lambda x: os.path.getmtime(x), reverse=True)[0]
    return FileResponse(file, filename=os.path.basename(file))

    @app.get("/health")
    def health_check():
     return {"status": "ok", "app": "دفتري", "version": "2.0.0", "systems": ["Android", "iPhone", "Mac", "Windows", "Linux"]}

     # ===== Admin Backups - النسخ الاحتياطي =====
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

@app.get("/admin/backups/list")
def list_backups(password: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    backups = []
    for root, dirs, files in os.walk("data/backups"):
        for file in files:
            path = os.path.join(root, file)
            try:
                size = os.path.getsize(path)
            except:
                size = 0
            backups.append({"الملف": path, "الحجم": size})
    backups = sorted(backups, key=lambda x: x["الملف"], reverse=True)
    if not backups:
        return {"رسالة": "لا توجد نسخ احتياطية بعد", "النسخ": []}
    return {"عدد_النسخ": len(backups), "النسخ": backups}

@app.get("/admin/backup/download")
def download_backup(password: str = "", file: str = ""):
    if password != ADMIN_PASSWORD:
        return {"error": "باسورد خطأ"}
    if file and os.path.exists(file):
        return FileResponse(file, filename=os.path.basename(file))
    all_files = []
    for root, dirs, files in os.walk("data/backups"):
        for f in files:
            all_files.append(os.path.join(root, f))
    if not all_files:
        return {"error": "لا توجد نسخ"}
    latest = sorted(all_files, key=lambda x: os.path.getmtime(x), reverse=True)[0]
    return FileResponse(latest, filename=os.path.basename(latest))


if __name__== "__main__":   
    port = int(os.environ.get("PORT", 8000))
    url = f"http://localhost:{port}"
    print(f"=== دفتري يشتغل على {url} ===")
    if os.name == 'nt':  # جوه هنا
        import threading, time
        def _open():
            time.sleep(1.5)
            open_in_edge(url)
        threading.Thread(target=_open, daemon=True).start()
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
